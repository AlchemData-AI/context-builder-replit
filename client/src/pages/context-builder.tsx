import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import ConnectionValidator from "@/components/ConnectionValidator";
import SchemaOverview from "@/components/SchemaOverview";
import SamplingConfiguration from "@/components/SamplingConfiguration";
import StatisticalAnalysis from "@/components/StatisticalAnalysis";
import AIContextGeneration from "@/components/AIContextGeneration";
import SMEInterview from "@/components/SMEInterview";
import KnowledgeGraph from "@/components/KnowledgeGraph";
import Sidebar from "@/components/Sidebar";

export default function ContextBuilder() {
  const [activeSection, setActiveSection] = useState("connections");
  const [connectionStatus, setConnectionStatus] = useState({
    postgresql: "pending",
    gemini: "pending",
    neo4j: "pending"
  });

  const renderMainContent = () => {
    switch (activeSection) {
      case "connections":
        return <ConnectionValidator onConnectionStatus={setConnectionStatus} />;
      case "schema":
        return <SchemaOverview />;
      case "sampling":
        return <SamplingConfiguration />;
      case "statistical":
        return <StatisticalAnalysis />;
      case "ai-context":
        return <AIContextGeneration />;
      case "sme-interview":
        return <SMEInterview />;
      case "knowledge-graph":
        return <KnowledgeGraph />;
      default:
        return <ConnectionValidator onConnectionStatus={setConnectionStatus} />;
    }
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="bg-card border-b border-border px-6 py-4 flex items-center justify-between">
        <div className="flex items-center space-x-4">
          <div className="w-8 h-8 bg-primary rounded-lg flex items-center justify-center">
            <i className="fas fa-flask text-primary-foreground text-sm"></i>
          </div>
          <div>
            <h1 className="text-xl font-semibold" data-testid="header-title">AlchemData Context Builder</h1>
            <p className="text-sm text-muted-foreground" data-testid="header-subtitle">MVP - Knowledge Graph Development Platform</p>
          </div>
        </div>
        <div className="flex items-center space-x-3">
          <span className="text-sm text-muted-foreground" data-testid="project-name">Project: MVP_Demo</span>
          <div className="w-2 h-2 bg-emerald-500 rounded-full" data-testid="status-indicator"></div>
        </div>
      </header>

      <div className="flex h-screen">
        <Sidebar 
          activeSection={activeSection} 
          onSectionChange={setActiveSection}
          connectionStatus={connectionStatus}
        />
        
        {/* Main Content */}
        <main className="flex-1 overflow-auto">
          <div className="p-6">
            {renderMainContent()}
          </div>
        </main>
      </div>
    </div>
  );
}
