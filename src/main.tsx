import React from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider, createBrowserRouter } from "react-router-dom";
import "./styles/globals.css";

window.addEventListener("contextmenu", (e) => e.preventDefault());
import { App } from "./app/App";
import { HomePage } from "./app/HomePage";
import { WorkspacePage } from "./app/WorkspacePage";
import { SettingsPage } from "./app/SettingsPage";
import { HelpPage } from "./app/HelpPage";

const router = createBrowserRouter([
  {
    path: "/",
    element: <App />,
    children: [
      { index: true, element: <HomePage /> },
      { path: "workspace", element: <WorkspacePage /> },
      { path: "workspace/:sessionId", element: <WorkspacePage /> },
      { path: "settings", element: <SettingsPage /> },
      { path: "help", element: <HelpPage /> },
    ],
  },
]);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RouterProvider router={router} />
  </React.StrictMode>,
);
