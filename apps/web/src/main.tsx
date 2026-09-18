import { API_VERSION } from "@mail-hub/contracts";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function App() {
  return (
    <main>
      <h1>Personal mail hub</h1>
      <p>The application foundation is ready.</p>
      <small>API {API_VERSION}</small>
    </main>
  );
}

const root = document.getElementById("root");

if (root === null) {
  throw new Error("The root element is missing.");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
