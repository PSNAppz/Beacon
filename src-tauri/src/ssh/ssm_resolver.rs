//! Resolve the *current* EC2 instance ID for an SSM session at connect time.
//!
//! Sessions that target a static instance work as before, but sessions that
//! target an Auto Scaling fleet would otherwise break every time AWS replaces
//! the instance. Three resolution modes:
//!
//! * `instance` — use the stored `ssm_instance_id` verbatim
//! * `tags`     — `ec2:DescribeInstances` filtered by tag key/value + running
//! * `asg`      — `autoscaling:DescribeAutoScalingGroups`, pick first InService

use crate::error::{AppError, AppResult};
use crate::storage::Session;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct TagFilter {
    key: String,
    value: String,
}

/// Build a shared SDK config honoring optional explicit credentials.
async fn build_sdk_config(
    region: &str,
    access_key_id: Option<&str>,
    secret_key: Option<&str>,
) -> aws_config::SdkConfig {
    use aws_config::Region;
    let mut loader = aws_config::defaults(aws_config::BehaviorVersion::latest())
        .region(Region::new(region.to_string()));
    if let (Some(kid), Some(sk)) = (access_key_id, secret_key) {
        use aws_sdk_ec2::config::Credentials;
        loader = loader.credentials_provider(Credentials::new(kid, sk, None, None, "beacon"));
    }
    loader.load().await
}

pub async fn resolve_instance_id(
    session: &Session,
    aws_secret: Option<&str>,
) -> AppResult<String> {
    let region = session
        .aws_region
        .as_deref()
        .ok_or_else(|| AppError::Ssh("AWS region is required for SSM sessions".into()))?;
    let kind = session.ssm_target_kind.as_str();

    match kind {
        "instance" | "" => session
            .ssm_instance_id
            .clone()
            .ok_or_else(|| AppError::Ssh("SSM instance ID is required".into())),

        "tags" => {
            let raw = session.ssm_tag_filters.as_deref().unwrap_or("[]");
            let filters: Vec<TagFilter> = serde_json::from_str(raw)
                .map_err(|e| AppError::Ssh(format!("invalid tag filters JSON: {e}")))?;
            if filters.is_empty() {
                return Err(AppError::Ssh(
                    "at least one tag filter is required".into(),
                ));
            }
            let cfg = build_sdk_config(region, session.aws_access_key_id.as_deref(), aws_secret)
                .await;
            let client = aws_sdk_ec2::Client::new(&cfg);
            let mut req = client.describe_instances().filters(
                aws_sdk_ec2::types::Filter::builder()
                    .name("instance-state-name")
                    .values("running")
                    .build(),
            );
            for f in &filters {
                req = req.filters(
                    aws_sdk_ec2::types::Filter::builder()
                        .name(format!("tag:{}", f.key))
                        .values(f.value.clone())
                        .build(),
                );
            }
            let resp = req.send().await.map_err(|e| {
                use aws_sdk_ec2::error::ProvideErrorMetadata;
                AppError::Ssh(format!(
                    "ec2:DescribeInstances failed: {} — {}",
                    e.code().unwrap_or("unknown"),
                    e.message().unwrap_or("no message")
                ))
            })?;
            resp.reservations()
                .iter()
                .flat_map(|r| r.instances())
                .find_map(|i| i.instance_id().map(|s| s.to_string()))
                .ok_or_else(|| {
                    AppError::Ssh("no running instances match the tag filters".into())
                })
        }

        "asg" => {
            let name = session
                .ssm_asg_name
                .as_deref()
                .ok_or_else(|| AppError::Ssh("ASG name is required".into()))?;
            let cfg = build_sdk_config(region, session.aws_access_key_id.as_deref(), aws_secret)
                .await;
            let client = aws_sdk_autoscaling::Client::new(&cfg);
            let resp = client
                .describe_auto_scaling_groups()
                .auto_scaling_group_names(name)
                .send()
                .await
                .map_err(|e| {
                    use aws_sdk_autoscaling::error::ProvideErrorMetadata;
                    AppError::Ssh(format!(
                        "autoscaling:DescribeAutoScalingGroups failed: {} — {}",
                        e.code().unwrap_or("unknown"),
                        e.message().unwrap_or("no message")
                    ))
                })?;
            resp.auto_scaling_groups()
                .iter()
                .flat_map(|g| g.instances())
                .find(|i| i.lifecycle_state().map(|s| s.as_str()) == Some("InService"))
                .and_then(|i| i.instance_id().map(|s| s.to_string()))
                .ok_or_else(|| {
                    AppError::Ssh(format!("no InService instances in ASG '{name}'"))
                })
        }

        other => Err(AppError::Ssh(format!(
            "unknown SSM target kind: {other}"
        ))),
    }
}
