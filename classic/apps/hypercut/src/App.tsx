import { StudioApp } from "@hyperframes/studio";
// Keep the complete upstream application as the product entry.
// Extensions belong inside Studio panels, not in a replacement shell.
export function App() { return <StudioApp />; }
