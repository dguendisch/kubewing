import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { inspect } from "./inspect";
import { connect } from "./store/store";
import { createTransport } from "./transport";
import "./theme.css";

connect(await createTransport());

if (import.meta.env.MODE !== "production") {
  (window as unknown as { __kw: { inspect: typeof inspect } }).__kw = { inspect };
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
