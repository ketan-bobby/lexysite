// main.tsx — Browser entry point for the public marketing site. Mounts the
// <App /> tree into #root and pulls in the global Tailwind stylesheet.
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(<App />);
