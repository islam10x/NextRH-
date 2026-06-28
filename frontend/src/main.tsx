import { createRoot } from "react-dom/client";
import { AuthProvider as OidcProvider } from "react-oidc-context";
import App from "./App.tsx";
import "./index.css";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { oidcConfig } from "./lib/oidc";

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <OidcProvider {...oidcConfig}>
      <App />
    </OidcProvider>
  </ErrorBoundary>
);
