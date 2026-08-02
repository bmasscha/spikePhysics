import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { registerSW } from "virtual:pwa-register";
import App from "./App";
import ErrorBoundary from "./components/ErrorBoundary";
import "./index.css";

// Keep the cached app fresh, but never block a coach mid-session on an update.
registerSW({ immediate: true });

const container = document.getElementById("root");
if (!container) throw new Error("#root missing from index.html");

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
