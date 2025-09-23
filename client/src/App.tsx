import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import ContextBuilder from "@/pages/context-builder";

function Router() {
  return (
    <Switch>
      <Route path="/" component={ContextBuilder} />
      <Route path="/context-builder" component={ContextBuilder} />
      {/* Fallback to context builder for any other route */}
      <Route component={ContextBuilder} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
