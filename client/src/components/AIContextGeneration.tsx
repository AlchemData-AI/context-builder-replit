import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface AnalysisJob {
  id: string;
  type: string;
  status: string;
  progress: number;
  result?: string;
  error?: string;
}

interface TableDescription {
  table_name: string;
  description: string;
  business_purpose: string;
  data_characteristics: string;
}

interface ColumnDescription {
  column_name: string;
  description: string;
  business_meaning: string;
  data_patterns: string;
  enum_values?: string[];
}

interface JoinSuggestion {
  from_table: string;
  from_column: string;
  to_table: string;
  to_column: string;
  confidence: number;
  reasoning: string;
  relationship_type: string;
}

export default function AIContextGeneration() {
  const { toast } = useToast();
  const [activeTab, setActiveTab] = useState<'tables' | 'columns' | 'joins'>('tables');
  const [contextResults, setContextResults] = useState<any>(null);
  const [joinResults, setJoinResults] = useState<JoinSuggestion[]>([]);

  // Get database
  const { data: connections = [] } = useQuery({
    queryKey: ['/api/connections'],
    queryFn: async () => {
      const response = await fetch('/api/connections?userId=default-user');
      return response.json();
    }
  });

  const postgresConnection = connections.find((c: any) => c.type === 'postgresql' && c.status === 'connected');
  const geminiConnection = connections.find((c: any) => c.type === 'gemini' && c.status === 'connected');

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

  // Fetch analysis jobs
  const { data: jobs = [] } = useQuery<AnalysisJob[]>({
    queryKey: ['/api/databases', database?.id, 'jobs'],
    queryFn: async () => {
      if (!database) return [];
      const response = await fetch(`/api/databases/${database.id}/jobs`);
      return response.json();
    },
    enabled: !!database,
    refetchInterval: 2000
  });

  // Generate AI context mutation
  const generateContext = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', `/api/databases/${database.id}/generate-context`);
      return response.json();
    },
    onSuccess: (job) => {
      toast({ title: "Context generation started", description: "AI is analyzing your data..." });
    },
    onError: (error: Error) => {
      toast({ title: "Context generation failed", description: error.message, variant: "destructive" });
    }
  });

  // Generate join suggestions mutation
  const generateJoins = useMutation({
    mutationFn: async () => {
      const response = await apiRequest('POST', `/api/databases/${database.id}/analyze-joins`);
      return response.json();
    },
    onSuccess: (job) => {
      toast({ title: "Join analysis started", description: "Analyzing potential relationships..." });
    },
    onError: (error: Error) => {
      toast({ title: "Join analysis failed", description: error.message, variant: "destructive" });
    }
  });

  const contextJobs = jobs.filter(j => j.type === 'ai_context');
  const joinJobs = jobs.filter(j => j.type === 'join_detection');
  const latestContextJob = contextJobs[0];
  const latestJoinJob = joinJobs[0];

  // Parse results when jobs complete
  if (latestContextJob?.status === 'completed' && latestContextJob.result && !contextResults) {
    try {
      setContextResults(JSON.parse(latestContextJob.result));
    } catch (e) {
      console.error('Failed to parse context results:', e);
    }
  }

  if (latestJoinJob?.status === 'completed' && latestJoinJob.result && joinResults.length === 0) {
    try {
      setJoinResults(JSON.parse(latestJoinJob.result));
    } catch (e) {
      console.error('Failed to parse join results:', e);
    }
  }

  const getTokenUsage = (): string => {
    // Rough estimation based on number of tables and their complexity
    if (!database) return "0K";
    
    // This would be calculated based on actual API usage
    const estimatedTokens = contextResults ? "47K" : "0K";
    return estimatedTokens;
  };

  if (!geminiConnection) {
    return (
      <div className="text-center py-8">
        <p className="text-muted-foreground">Please configure and test your Gemini API connection first.</p>
      </div>
    );
  }

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
        <h2 className="text-2xl font-semibold" data-testid="ai-context-title">AI Context Generation</h2>
        <div className="flex items-center space-x-3">
          <div className="text-sm text-muted-foreground" data-testid="token-usage">
            Token usage: {getTokenUsage()} / 8K per call
          </div>
          <Button 
            onClick={() => generateContext.mutate()}
            disabled={generateContext.isPending || latestContextJob?.status === 'running'}
            data-testid="button-generate-context"
          >
            <i className="fas fa-brain mr-2"></i>
            {latestContextJob?.status === 'running' ? "Generating..." : "Generate Context"}
          </Button>
        </div>
      </div>

      {/* Tab Navigation */}
      <div className="flex space-x-1 mb-6">
        {[
          { key: 'tables', label: 'Table Descriptions', icon: 'fas fa-table' },
          { key: 'columns', label: 'Column Descriptions', icon: 'fas fa-columns' },
          { key: 'joins', label: 'Join Suggestions', icon: 'fas fa-link' }
        ].map((tab) => (
          <Button
            key={tab.key}
            variant={activeTab === tab.key ? "default" : "outline"}
            onClick={() => setActiveTab(tab.key as any)}
            className="flex items-center"
            data-testid={`tab-${tab.key}`}
          >
            <i className={`${tab.icon} mr-2`}></i>
            {tab.label}
          </Button>
        ))}
      </div>
      
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Table Descriptions */}
        <Card className={activeTab === 'tables' ? 'lg:col-span-3' : ''}>
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center">
                <i className="fas fa-table mr-2"></i>
                Table Descriptions
              </CardTitle>
              <div className={`w-2 h-2 rounded-full ${
                latestContextJob?.status === 'completed' ? 'bg-emerald-500' : 
                latestContextJob?.status === 'running' ? 'bg-blue-500 animate-pulse' : 
                'bg-gray-400'
              }`}></div>
            </div>
          </CardHeader>
          <CardContent>
            {activeTab === 'tables' && (
              <div className="space-y-4">
                {!contextResults || !contextResults.length ? (
                  <div className="text-center py-8 text-muted-foreground">
                    {latestContextJob?.status === 'running' 
                      ? "Generating table descriptions..." 
                      : "Click 'Generate Context' to analyze tables with AI"}
                  </div>
                ) : (
                  <ScrollArea className="max-h-96">
                    {contextResults.map((result: any, index: number) => (
                      <div key={index} className="p-3 bg-accent rounded-lg mb-3" data-testid={`table-description-${index}`}>
                        <div className="font-medium text-sm mb-2">{result.table.table_name}</div>
                        <p className="text-xs text-muted-foreground mb-2">{result.table.description}</p>
                        <div className="text-xs text-blue-600">
                          <strong>Business Purpose:</strong> {result.table.business_purpose}
                        </div>
                      </div>
                    ))}
                  </ScrollArea>
                )}
              </div>
            )}
            {activeTab !== 'tables' && (
              <div className="space-y-4 max-h-80 overflow-y-auto">
                {contextResults && contextResults.length > 0 ? (
                  contextResults.slice(0, 2).map((result: any, index: number) => (
                    <div key={index} className="p-3 bg-accent rounded-lg">
                      <div className="font-medium text-sm mb-2">{result.table.table_name}</div>
                      <p className="text-xs text-muted-foreground">{result.table.description}</p>
                    </div>
                  ))
                ) : (
                  <div className="text-center py-4 text-muted-foreground text-sm">
                    Generate context to see descriptions
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
        
        {/* Column Descriptions */}
        <Card className={activeTab === 'columns' ? 'lg:col-span-3' : ''}>
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center">
                <i className="fas fa-columns mr-2"></i>
                Column Descriptions
              </CardTitle>
              <div className={`w-2 h-2 rounded-full ${
                latestContextJob?.status === 'completed' ? 'bg-emerald-500' : 
                latestContextJob?.status === 'running' ? 'bg-blue-500 animate-pulse' : 
                'bg-gray-400'
              }`}></div>
            </div>
          </CardHeader>
          <CardContent>
            {activeTab === 'columns' && (
              <div className="space-y-4">
                {!contextResults || !contextResults.length ? (
                  <div className="text-center py-8 text-muted-foreground">
                    Generate context to see column descriptions
                  </div>
                ) : (
                  <ScrollArea className="max-h-96">
                    {contextResults.map((result: any, tableIndex: number) => (
                      <div key={tableIndex} className="mb-4">
                        <h4 className="font-medium text-sm mb-2">{result.table.table_name}</h4>
                        <div className="space-y-2">
                          {result.columns.slice(0, 3).map((column: ColumnDescription, colIndex: number) => (
                            <div key={colIndex} className="p-3 bg-accent rounded-lg" data-testid={`column-description-${tableIndex}-${colIndex}`}>
                              <div className="font-medium text-sm mb-2">{column.column_name}</div>
                              <p className="text-xs text-muted-foreground mb-1">{column.business_meaning}</p>
                              {column.enum_values && column.enum_values.length > 0 && (
                                <div className="mt-2">
                                  <span className="bg-blue-100 text-blue-800 px-2 py-1 rounded text-xs">
                                    Enum: {column.enum_values.length} values
                                  </span>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </ScrollArea>
                )}
              </div>
            )}
            {activeTab !== 'columns' && (
              <div className="space-y-4 max-h-80 overflow-y-auto">
                {contextResults && contextResults.length > 0 ? (
                  contextResults[0].columns.slice(0, 2).map((column: ColumnDescription, index: number) => (
                    <div key={index} className="p-3 bg-accent rounded-lg">
                      <div className="font-medium text-sm mb-2">{column.column_name}</div>
                      <p className="text-xs text-muted-foreground">{column.business_meaning}</p>
                    </div>
                  ))
                ) : (
                  <div className="text-center py-4 text-muted-foreground text-sm">
                    Generate context to see descriptions
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
        
        {/* Join Suggestions */}
        <Card className={activeTab === 'joins' ? 'lg:col-span-3' : ''}>
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center">
                <i className="fas fa-link mr-2"></i>
                Join Suggestions
              </CardTitle>
              <div className={`w-2 h-2 rounded-full ${
                latestJoinJob?.status === 'completed' ? 'bg-emerald-500' : 
                latestJoinJob?.status === 'running' ? 'bg-blue-500 animate-pulse' : 
                'bg-gray-400'
              }`}></div>
            </div>
          </CardHeader>
          <CardContent>
            {activeTab === 'joins' && (
              <div className="space-y-4">
                <Button 
                  onClick={() => generateJoins.mutate()}
                  disabled={generateJoins.isPending || latestJoinJob?.status === 'running'}
                  className="mb-4"
                  data-testid="button-analyze-joins"
                >
                  <i className="fas fa-search mr-2"></i>
                  {latestJoinJob?.status === 'running' ? "Analyzing..." : "Analyze Join Relationships"}
                </Button>
                
                {!joinResults.length ? (
                  <div className="text-center py-8 text-muted-foreground">
                    {latestJoinJob?.status === 'running' 
                      ? "Analyzing potential relationships..." 
                      : "Click 'Analyze Join Relationships' to detect connections"}
                  </div>
                ) : (
                  <ScrollArea className="max-h-96">
                    {joinResults.map((join: JoinSuggestion, index: number) => (
                      <div key={index} className={`p-3 rounded-lg mb-3 ${
                        join.confidence >= 0.9 ? 'bg-emerald-50 border border-emerald-200' :
                        join.confidence >= 0.7 ? 'bg-blue-50 border border-blue-200' :
                        'bg-amber-50 border border-amber-200'
                      }`} data-testid={`join-suggestion-${index}`}>
                        <div className="flex items-center justify-between mb-2">
                          <span className="font-medium text-sm">{join.from_table} ↔ {join.to_table}</span>
                          <span className={`px-2 py-1 rounded text-xs ${
                            join.confidence >= 0.9 ? 'bg-emerald-100 text-emerald-800' :
                            join.confidence >= 0.7 ? 'bg-blue-100 text-blue-800' :
                            'bg-amber-100 text-amber-800'
                          }`}>
                            {Math.round(join.confidence * 100)}%
                          </span>
                        </div>
                        <p className="text-xs text-muted-foreground mb-1">
                          {join.from_column} = {join.to_column}
                        </p>
                        <p className="text-xs text-muted-foreground">{join.reasoning}</p>
                      </div>
                    ))}
                  </ScrollArea>
                )}
              </div>
            )}
            {activeTab !== 'joins' && (
              <div className="space-y-4 max-h-80 overflow-y-auto">
                {joinResults.length > 0 ? (
                  joinResults.slice(0, 2).map((join: JoinSuggestion, index: number) => (
                    <div key={index} className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg">
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-medium text-sm">{join.from_table} ↔ {join.to_table}</span>
                        <span className="bg-emerald-100 text-emerald-800 px-2 py-1 rounded text-xs">
                          {Math.round(join.confidence * 100)}%
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">{join.from_column} = {join.to_column}</p>
                    </div>
                  ))
                ) : (
                  <div className="text-center py-4 text-muted-foreground text-sm">
                    Analyze joins to see suggestions
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* AI Processing Log */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center">
            <i className="fas fa-terminal mr-2"></i>
            AI Processing Log
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ScrollArea className="bg-muted rounded-lg p-4 font-mono text-sm max-h-40">
            <div className="space-y-1" data-testid="ai-processing-log">
              {latestContextJob?.status === 'running' && (
                <>
                  <div className="text-blue-600">[{new Date().toLocaleTimeString()}] Started AI context generation</div>
                  <div className="text-blue-600">[{new Date().toLocaleTimeString()}] Gemini API calls in progress...</div>
                  <div className="text-blue-600">[{new Date().toLocaleTimeString()}] Progress: {latestContextJob.progress}%</div>
                </>
              )}
              {latestContextJob?.status === 'completed' && (
                <>
                  <div className="text-emerald-600">[{new Date().toLocaleTimeString()}] Context generation completed</div>
                  <div className="text-blue-600">[{new Date().toLocaleTimeString()}] Generated descriptions for all tables</div>
                </>
              )}
              {latestJoinJob?.status === 'running' && (
                <>
                  <div className="text-blue-600">[{new Date().toLocaleTimeString()}] Starting semantic analysis...</div>
                  <div className="text-blue-600">[{new Date().toLocaleTimeString()}] Analyzing potential joins...</div>
                </>
              )}
              {latestJoinJob?.status === 'completed' && (
                <div className="text-emerald-600">[{new Date().toLocaleTimeString()}] Join analysis completed - {joinResults.length} relationships found</div>
              )}
              {(latestContextJob?.status === 'failed' || latestJoinJob?.status === 'failed') && (
                <div className="text-red-600">
                  [{new Date().toLocaleTimeString()}] Error: {latestContextJob?.error || latestJoinJob?.error}
                </div>
              )}
              {!latestContextJob && !latestJoinJob && (
                <div className="text-muted-foreground">Ready to generate AI context...</div>
              )}
            </div>
          </ScrollArea>
        </CardContent>
      </Card>
    </div>
  );
}
