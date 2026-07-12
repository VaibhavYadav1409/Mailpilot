import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      // Default staleTime is 0, which means every remount (switching
      // filters, reopening a dialog, refocusing the window) refetches
      // immediately even if the data was just fetched. 15s keeps things
      // feeling instant for normal navigation while the 45s background
      // sync (Home.tsx) and explicit invalidations after mutations still
      // keep data fresh.
      staleTime: 15_000,
    },
  },
});

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <App />
  </QueryClientProvider>
);
