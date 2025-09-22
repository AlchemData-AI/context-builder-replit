import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface GraphStats {
  personaCount: number;
  tableCount: number;
  columnCount: number;
  valueCount: number;
  relationshipCount: number;
}

interface AgentPersona {
  id: string;
  name: string;
  description: string;
  keywords?: string[];
}

export default function KnowledgeGraph() {
  const { toast } = useToast();
  const [selectedNeo4jConnection, setSelectedNeo4jConnection] = useState<string>("");
  const [graphStats, setGraphStats] = useState<GraphStats | null>(null);

  // Get connections
  const { data: connections = [] } = useQuery({
    queryKey: ['/api/connections'],
    queryFn: async () => {
      const response = await fetch('/api/connections?userId=default-user');
      return response.json();
    }
  });

  const postgresConnection = connections.find((c: any) => c.type === 'postgresql' && c.status === 'connected');
  const neo4jConnections = connections.filter((c: any) => c.type === 'neo4j');
  const connectedNeo4j = neo4jConnections.find((c: any) => c.status === 'connected');

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

  // Fetch agent personas
  const { data: personas = [] } = useQuery<AgentPersona[]>({
    queryKey: ['/api/databases', database?.id, 'personas'],
    queryFn: async () => {
      if (!database) return [];
      const response = await fetch(`/api/databases/${database.id}/personas`);
      return response.json();
    },
    enabled: !!database
  });

  // Fetch selected tables for context
  const { data: tables = [] } = useQuery({
    queryKey: ['/api/databases', database?.id, 'tables'],
    queryFn: async () => {
      if (!database) return [];
      const response = await fetch(`/api/databases/${database.id}/tables`);
      return response.json();
    },
    enabled: !!database
  });

  const selectedTables = tables.filter((t: any) => t.isSelected);

  // Build knowledge graph mutation
  const buildGraph = useMutation({
    mutationFn: async (neo4jConnectionId: string) => {
      const response = await apiRequest('POST', `/api/databases/${database.id}/build-graph`, {
        neo4jConnectionId
      });
      return response.json();
    },
    onSuccess: (data) => {
      toast({ 
        title: "Knowledge graph built successfully", 
        description: `Graph created in namespace: ${data.namespace}` 
      });
      fetchGraphStats();
    },
    onError: (error: Error) => {
      toast({ title: "Graph building failed", description: error.message, variant: "destructive" });
    }
  });

  // Fetch graph statistics
  const fetchGraphStats = async () => {
    if (!database || !selectedNeo4jConnection) return;
    
    try {
      const response = await fetch(
        `/api/databases/${database.id}/graph-stats?neo4jConnectionId=${selectedNeo4jConnection}`
      );
      if (response.ok) {
        const stats = await response.json();
        setGraphStats(stats);
      }
    } catch (error) {
      console.error('Failed to fetch graph stats:', error);
    }
  };

  // Auto-select connected Neo4j connection
  if (connectedNeo4j && !selectedNeo4jConnection) {
    setSelectedNeo4jConnection(connectedNeo4j.id);
    setTimeout(() => fetchGraphStats(), 1000);
  }

  const getPersonaColor = (index: number) => {
    const colors = ['purple', 'blue', 'green', 'amber', 'pink'];
    return colors[index % colors.length];
  };

  const handleBuildGraph = () => {
    if (!selectedNeo4jConnection) {
      toast({ title: "Neo4j connection required", description: "Please select a Neo4j connection first", variant: "destructive" });
      return;
    }
    buildGraph.mutate(selectedNeo4jConnection);
  };

  if (!database) {
    return (
      <div className="text-center py-8">
        <p className="text-muted-foreground">Please configure your database connection first.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-semibold" data-testid="knowledge-graph-title">Neo4j Knowledge Graph</h2>
        <div className="flex space-x-2">
          <Button 
            variant="outline"
            onClick={fetchGraphStats}
            disabled={!selectedNeo4jConnection}
            data-testid="button-view-graph"
          >
            <i className="fas fa-eye mr-2"></i>
            View Graph
          </Button>
          <Button 
            onClick={handleBuildGraph}
            disabled={buildGraph.isPending || selectedTables.length === 0}
            data-testid="button-build-graph"
          >
            <i className="fas fa-upload mr-2"></i>
            {buildGraph.isPending ? "Building..." : "Build Graph"}
          </Button>
        </div>
      </div>

      {/* Neo4j Connection Selection */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center">
            <i className="fas fa-database mr-2"></i>
            Neo4j Configuration
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium text-muted-foreground block mb-2">
                Neo4j Connection
              </label>
              <Select 
                value={selectedNeo4jConnection} 
                onValueChange={(value) => {
                  setSelectedNeo4jConnection(value);
                  setTimeout(() => fetchGraphStats(), 500);
                }}
              >
                <SelectTrigger className="w-full" data-testid="select-neo4j-connection">
                  <SelectValue placeholder="Select Neo4j connection" />
                </SelectTrigger>
                <SelectContent>
                  {neo4jConnections.map((conn: any) => (
                    <SelectItem key={conn.id} value={conn.id}>
                      {conn.name} ({conn.status})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {!connectedNeo4j && (
              <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                <div className="flex items-center">
                  <i className="fas fa-exclamation-triangle text-amber-600 mr-2"></i>
                  <div className="text-sm">
                    <p className="font-medium text-amber-800">No connected Neo4j instance</p>
                    <p className="text-amber-600">Please configure and test your Neo4j connection first.</p>
                  </div>
                </div>
              </div>
            )}

            <div className="text-xs text-muted-foreground">
              <p>Database: alchemdata_mvp</p>
              <p>Namespace: database_{database.id}</p>
            </div>
          </div>
        </CardContent>
      </Card>
      
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Graph Structure */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center">
              <i className="fas fa-sitemap mr-2"></i>
              Hierarchical Structure
            </CardTitle>
            <p className="text-sm text-muted-foreground">Agent Persona → Table → Column → Value nodes</p>
          </CardHeader>
          <CardContent>
            {personas.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <p>No agent personas defined yet.</p>
                <p className="text-sm">Complete SME interview to create personas.</p>
              </div>
            ) : (
              <ScrollArea className="max-h-96">
                <div className="space-y-4">
                  {personas.slice(0, 3).map((persona, index) => {
                    const color = getPersonaColor(index);
                    return (
                      <div 
                        key={persona.id} 
                        className={`p-4 bg-${color}-50 border border-${color}-200 rounded-lg`}
                        data-testid={`persona-structure-${index}`}
                      >
                        <div className="flex items-center mb-3">
                          <i className={`fas fa-user-cog text-${color}-600 mr-2`}></i>
                          <span className={`font-medium text-${color}-800`}>{persona.name}</span>
                        </div>
                        <p className={`text-sm text-${color}-700 mb-3`}>{persona.description}</p>
                        
                        {/* Sample table structure */}
                        <div className="ml-4 space-y-2">
                          {selectedTables.slice(0, 3).map((table: any, tableIndex: number) => (
                            <div key={tableIndex} className={`p-2 bg-blue-50 border border-blue-200 rounded`}>
                              <div className="flex items-center">
                                <i className="fas fa-table text-blue-600 mr-2"></i>
                                <span className="text-sm font-medium text-blue-800">{table.name}</span>
                                <span className="text-xs text-blue-600 ml-2">
                                  ({table.columnCount} columns)
                                </span>
                              </div>
                            </div>
                          ))}
                          {selectedTables.length > 3 && (
                            <div className="text-xs text-muted-foreground ml-2">
                              ... and {selectedTables.length - 3} more tables
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}

                  {/* Sample column and value nodes */}
                  <div className="ml-8">
                    <div className="p-3 bg-green-50 border border-green-200 rounded-lg">
                      <div className="flex items-center mb-2">
                        <i className="fas fa-columns text-green-600 mr-2"></i>
                        <span className="text-sm font-medium text-green-800">Sample Column Node</span>
                      </div>
                      <div className="ml-6 grid grid-cols-2 gap-1">
                        <span className="bg-white px-2 py-1 rounded text-xs">pending</span>
                        <span className="bg-white px-2 py-1 rounded text-xs">confirmed</span>
                        <span className="bg-white px-2 py-1 rounded text-xs">shipped</span>
                        <span className="bg-white px-2 py-1 rounded text-xs">delivered</span>
                      </div>
                    </div>
                  </div>
                </div>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
        
        {/* Graph Statistics */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center">
              <i className="fas fa-chart-bar mr-2"></i>
              Graph Statistics
            </CardTitle>
            <p className="text-sm text-muted-foreground">Current knowledge graph metrics</p>
          </CardHeader>
          <CardContent>
            {!graphStats ? (
              <div className="text-center py-8 text-muted-foreground">
                {selectedNeo4jConnection 
                  ? "Click 'Build Graph' to create the knowledge graph"
                  : "Select a Neo4j connection to view statistics"}
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-4 mb-6">
                  <div className="text-center p-3 bg-purple-50 rounded-lg" data-testid="stat-personas">
                    <div className="text-xl font-bold text-purple-600">{graphStats.personaCount}</div>
                    <div className="text-sm text-purple-800">Agent Personas</div>
                  </div>
                  <div className="text-center p-3 bg-blue-50 rounded-lg" data-testid="stat-tables">
                    <div className="text-xl font-bold text-blue-600">{graphStats.tableCount}</div>
                    <div className="text-sm text-blue-800">Table Nodes</div>
                  </div>
                  <div className="text-center p-3 bg-green-50 rounded-lg" data-testid="stat-columns">
                    <div className="text-xl font-bold text-green-600">{graphStats.columnCount}</div>
                    <div className="text-sm text-green-800">Column Nodes</div>
                  </div>
                  <div className="text-center p-3 bg-amber-50 rounded-lg" data-testid="stat-values">
                    <div className="text-xl font-bold text-amber-600">{graphStats.valueCount}</div>
                    <div className="text-sm text-amber-800">Value Nodes</div>
                  </div>
                </div>
                
                <div className="space-y-3">
                  <div className="p-3 bg-accent rounded-lg">
                    <div className="text-sm font-medium mb-1">Relationship Coverage</div>
                    <div className="flex justify-between text-xs">
                      <span>Total Relations</span>
                      <span data-testid="text-total-relations">{graphStats.relationshipCount}</span>
                    </div>
                    <div className="w-full bg-muted rounded-full h-2 mt-1">
                      <div className="bg-emerald-500 h-2 rounded-full" style={{ width: '85%' }}></div>
                    </div>
                  </div>
                  
                  <div className="p-3 bg-accent rounded-lg">
                    <div className="text-sm font-medium mb-1">Context Completeness</div>
                    <div className="flex justify-between text-xs">
                      <span>Nodes with Context</span>
                      <span>{Math.round((graphStats.columnCount / (graphStats.columnCount + graphStats.valueCount)) * 100)}%</span>
                    </div>
                    <div className="w-full bg-muted rounded-full h-2 mt-1">
                      <div className="bg-amber-500 h-2 rounded-full" style={{ width: '63%' }}></div>
                    </div>
                  </div>
                </div>
              </>
            )}

            {connectedNeo4j && (
              <div className="mt-6 p-4 bg-emerald-50 border border-emerald-200 rounded-lg">
                <div className="flex items-center">
                  <i className="fas fa-database text-emerald-600 mr-2"></i>
                  <div className="text-sm">
                    <p className="font-medium text-emerald-800" data-testid="neo4j-status">Neo4j Status: Connected</p>
                    <p className="text-emerald-600">Ready to build knowledge graph</p>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Build Instructions */}
      {selectedTables.length === 0 && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center">
              <i className="fas fa-info-circle mr-2"></i>
              Getting Started
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3 text-sm">
              <p className="text-muted-foreground">To build your knowledge graph, you need to:</p>
              <ol className="list-decimal list-inside space-y-1 text-muted-foreground ml-4">
                <li>Select tables in Schema Overview</li>
                <li>Run statistical analysis on selected tables</li>
                <li>Generate AI context for better understanding</li>
                <li>Complete SME interview to validate context</li>
                <li>Build the knowledge graph with validated data</li>
              </ol>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
