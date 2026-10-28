import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./index.css";

// No StrictMode: its double effect in dev would send every live audit twice, and the second waits for the
// first on the single Z3 Context.
const root = document.getElementById("root");
if (root === null) throw new Error("No #root element");
createRoot(root).render(<App />);
