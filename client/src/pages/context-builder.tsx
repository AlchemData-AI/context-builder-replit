import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import ConnectionValidator from "@/components/ConnectionValidator";
import SchemaOverview from "@/components/SchemaOverview";
import SamplingConfiguration from "@/components/SamplingConfiguration";
import StatisticalAnalysis from "@/components/StatisticalAnalysis";
import AIContextGeneration from "@/components/AIContextGeneration";
import SMEInterview from "@/components/SMEInterview";
import KnowledgeGraph from "@/components/KnowledgeGraph";
import Sidebar from "@/components/Sidebar";

// CSV Export Interface Component
function CSVExportInterface() {
  const { toast } = useToast();
  
  // Get database
  const { data: connections = [] } = useQuery({
    queryKey: ['/api/connections'],
    queryFn: async () => {
      const response = await fetch('/api/connections?userId=default-user');
      return response.json();
    }
  });

  const postgresConnection = connections.find((c: any) => c.type === 'postgresql' && c.status === 'connected');

  const { data: databases = [] } = useQuery({
    queryKey: ['/api/databases', postgresConnection?.id],
    queryFn: async () => {
      if (!postgresConnection) return [];
      const response = await fetch(`/api/databases?connectionId=${postgresConnection.id}`);
      return response.json();
    },
    enabled: !!postgresConnection
  });

  const database = databases[0];

  const handleExport = async (endpoint: string, filename: string, description: string) => {
    if (!database) return;
    
    try {
      const response = await fetch(endpoint);
      if (!response.ok) {
        throw new Error('Export failed');
      }
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
      
      toast({ title: "Export successful", description: description });
    } catch (error) {
      toast({ 
        title: "Export failed", 
        description: `Failed to export ${description.toLowerCase()}`, 
        variant: "destructive" 
      });
    }
  };

  if (!database) {
    return (
      <div className="text-center py-8">
        <p className="text-muted-foreground">Please connect to a database first.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-semibold" data-testid="csv-export-title">CSV Export Reports</h2>
        <p className="text-muted-foreground">Export your database analysis and SME interview data in CSV format</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center">
              <i className="fas fa-user-edit mr-2"></i>
              SME Questions & Responses
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">
              Export all SME interview questions and responses for analysis
            </p>
            <Button 
              onClick={() => handleExport(
                `/api/databases/${database.id}/export-csv`,
                `${database.name}-sme-questions.csv`,
                "SME questions exported to CSV"
              )}
              className="w-full"
              data-testid="button-export-sme-csv"
            >
              <i className="fas fa-download mr-2"></i>
              Export SME Q&A CSV
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center">
              <i className="fas fa-database mr-2"></i>
              Complete Database Analysis
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">
              Export comprehensive database analysis including schema, statistics, and AI context
            </p>
            <Button 
              onClick={() => handleExport(
                `/api/databases/${database.id}/export-data?format=csv`,
                `${database.name}-complete-analysis.csv`,
                "Complete database analysis exported to CSV"
              )}
              className="w-full"
              data-testid="button-export-complete-csv"
            >
              <i className="fas fa-file-csv mr-2"></i>
              Export Complete CSV
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// JSON Export Interface Component
function JSONExportInterface() {
  const { toast } = useToast();
  
  // Get database
  const { data: connections = [] } = useQuery({
    queryKey: ['/api/connections'],
    queryFn: async () => {
      const response = await fetch('/api/connections?userId=default-user');
      return response.json();
    }
  });

  const postgresConnection = connections.find((c: any) => c.type === 'postgresql' && c.status === 'connected');

  const { data: databases = [] } = useQuery({
    queryKey: ['/api/databases', postgresConnection?.id],
    queryFn: async () => {
      if (!postgresConnection) return [];
      const response = await fetch(`/api/databases?connectionId=${postgresConnection.id}`);
      return response.json();
    },
    enabled: !!postgresConnection
  });

  const database = databases[0];

  const handleJSONExport = async () => {
    if (!database) return;
    
    try {
      const response = await fetch(`/api/databases/${database.id}/export-data?format=json`);
      if (!response.ok) {
        throw new Error('Export failed');
      }
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${database.name}-complete-export.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
      
      toast({ title: "Export successful", description: "Database analysis exported to JSON" });
    } catch (error) {
      toast({ 
        title: "Export failed", 
        description: "Failed to export JSON data", 
        variant: "destructive" 
      });
    }
  };

  if (!database) {
    return (
      <div className="text-center py-8">
        <p className="text-muted-foreground">Please connect to a database first.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-semibold" data-testid="json-export-title">JSON Export</h2>
        <p className="text-muted-foreground">Export your database analysis in structured JSON format</p>
      </div>

      <Card className="max-w-md">
        <CardHeader>
          <CardTitle className="flex items-center">
            <i className="fas fa-file-code mr-2"></i>
            Complete Database Export
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            Export all database analysis data in JSON format including schema, statistics, AI context, and SME responses
          </p>
          <Button 
            onClick={handleJSONExport}
            className="w-full"
            data-testid="button-export-json"
          >
            <i className="fas fa-download mr-2"></i>
            Export JSON
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

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
      case "csv-export":
        return <CSVExportInterface />;
      case "json-export":
        return <JSONExportInterface />;
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
