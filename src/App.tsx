import { PerformanceOverlay } from "./components/PerformanceOverlay";
import { MainView } from "./views/MainView";

export function App() {
  return (
    <div className="h-full overflow-hidden bg-sidebar">
      <MainView />
      <PerformanceOverlay />
    </div>
  );
}
