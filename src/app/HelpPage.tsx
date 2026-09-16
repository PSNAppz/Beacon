import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import guide from "../content/user-guide.md?raw";

// The guide references its diagrams with relative paths (./images/x.svg). Vite
// resolves those to hashed asset URLs here so the same markdown file renders in
// the app and on GitHub without two copies of the content.
const images = import.meta.glob("../content/images/*.svg", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

function resolveImage(src: string): string {
  const name = src.split("/").pop();
  const key = Object.keys(images).find((k) => k.endsWith(`/${name}`));
  return key ? images[key] : src;
}

/** Turn a heading's text into the anchor id the guide's own links point at. */
function slug(children: React.ReactNode): string {
  return String(children)
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

export function HelpPage() {
  const content = useMemo(
    () => (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="mb-3 mt-2 text-3xl font-semibold tracking-tight">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2
              id={slug(children)}
              className="mb-4 mt-12 scroll-mt-6 border-b border-border pb-2 text-xl font-semibold tracking-tight"
            >
              {children}
            </h2>
          ),
          h3: ({ children }) => (
            <h3 id={slug(children)} className="mb-2 mt-8 scroll-mt-6 text-[15px] font-semibold">
              {children}
            </h3>
          ),
          p: ({ children }) => <p className="my-3 leading-relaxed text-fg/85">{children}</p>,
          ul: ({ children }) => <ul className="my-3 ml-5 list-disc space-y-1.5 text-fg/85">{children}</ul>,
          ol: ({ children }) => <ol className="my-3 ml-5 list-decimal space-y-1.5 text-fg/85">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed pl-1">{children}</li>,
          strong: ({ children }) => <strong className="font-semibold text-fg">{children}</strong>,
          a: ({ href, children }) => (
            <a href={href} className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent">
              {children}
            </a>
          ),
          code: ({ children }) => (
            <code className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[12.5px] text-fg">
              {children}
            </code>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-4 rounded-r-lg border-l-2 border-accent/50 bg-surface/60 py-1 pl-4 pr-3 text-fg/80">
              {children}
            </blockquote>
          ),
          hr: () => <hr className="my-10 border-border" />,
          table: ({ children }) => (
            <div className="my-4 overflow-x-auto rounded-lg border border-border">
              <table className="w-full border-collapse text-[13px]">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead className="bg-surface-2">{children}</thead>,
          th: ({ children }) => (
            <th className="border-b border-border px-3 py-2 text-left font-semibold text-fg">{children}</th>
          ),
          td: ({ children }) => (
            <td className="border-b border-border/60 px-3 py-2 align-top text-fg/85">{children}</td>
          ),
          img: ({ src, alt }) => (
            <figure className="my-6">
              <img
                src={resolveImage(String(src))}
                alt={alt ?? ""}
                className="w-full rounded-xl border border-border"
              />
              {alt ? (
                <figcaption className="mt-2 text-center text-[12px] text-muted">{alt}</figcaption>
              ) : null}
            </figure>
          ),
        }}
      >
        {guide}
      </ReactMarkdown>
    ),
    [],
  );

  return (
    <div className="h-full overflow-y-auto px-8 py-8">
      <article className="mx-auto max-w-3xl text-sm">{content}</article>
    </div>
  );
}
