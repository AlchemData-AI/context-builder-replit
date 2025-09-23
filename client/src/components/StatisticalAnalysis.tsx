import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface Column {
  id: string;
  name: string;
  dataType: string;
  cardinality?: number;
  nullPercentage?: string;
  distinctValues?: string;
}

interface AnalysisJob {
  id: string;
  type: string;
  status: string;
  progress: number;
  result?: string;
  error?: string;
}

interface StatisticalSummary {
  totalTables: number;
  analyzedTables: number;
  totalColumns: number;
  analyzedColumns: number;
  lowCardinalityColumns: number;
  highNullColumns: number;
  potentialJoinColumns: number;
  patterns: string[];
}

export default function StatisticalAnalysis() {
  const { toast } = useToast();
  const [currentAnalysis, setCurrentAnalysis] = useState<AnalysisJob | null>(null);

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

  // Fetch selected tables
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

  // Fetch analysis jobs
  const { data: jobs = [] } = useQuery<AnalysisJob[]>({
    queryKey: ['/api/databases', database?.id, 'jobs'],
    queryFn: async () => {
      if (!database) return [];
      const response = await fetch(`/api/databases/${database.id}/jobs`);
      return response.json();
    },
    enabled: !!database,
    refetchInterval: currentAnalysis ? 2000 : false
  });

  // Fetch statistical summary
  const { data: summary } = useQuery<StatisticalSummary>({
    queryKey: ['/api/databases', database?.id, 'statistical-summary'],
    queryFn: async () => {
      if (!database) return null;
      const response = await fetch(`/api/databases/${database.id}/statistical-summary`);
      return response.json();
    },
    enabled: !!database
  });

  // Run statistical analysis mutation
  const runAnalysis = useMutation({
    mutationFn: async (tableId: string) => {
      const response = await apiRequest('POST', `/api/tables/${tableId}/analyze-statistics`);
      return response.json();
    },
    onSuccess: (job) => {
      setCurrentAnalysis(job);
      toast({ title: "Statistical analysis started", description: "Analysis is running in the background" });
    },
    onError: (error: Error) => {
      toast({ title: "Analysis failed", description: error.message, variant: "destructive" });
    }
  });

  const runAllAnalysis = async () => {
    for (const table of selectedTables) {
      try {
        const job = await runAnalysis.mutateAsync(table.id);
        setCurrentAnalysis(job);
      } catch (error) {
        console.error(`Failed to analyze table ${table.name}:`, error);
      }
    }
  };

  const statisticalJobs = jobs.filter(j => j.type === 'statistical');
  const latestJob = statisticalJobs[0];
  const runningJobs = statisticalJobs.filter(j => j.status === 'running');

  if (!database || selectedTables.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-muted-foreground">Please select tables for analysis first.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-semibold" data-testid="statistical-title">Statistical Analysis Engine</h2>
        <div className="flex space-x-2">
          <div className="flex space-x-2">
            <Button 
              variant="outline"
              onClick={() => {
                // Export analysis results as JSON
                if (summary) {
                  const blob = new Blob([JSON.stringify(summary, null, 2)], { type: 'application/json' });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = 'statistical-analysis.json';
                  a.click();
                  URL.revokeObjectURL(url);
                }
              }}
              data-testid="button-export-json"
            >
              <i className="fas fa-download mr-2"></i>
              Export Analysis
            </Button>
            <Button 
              variant="outline"
              onClick={() => {
                if (database) {
                  const url = `/api/databases/${database.id}/export-data?format=json`;
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `${database.name}-complete-export.json`;
                  a.click();
                  toast({ title: "Download started", description: "Complete database export (JSON)" });
                }
              }}
              data-testid="button-export-complete-json"
            >
              <i className="fas fa-file-export mr-2"></i>
              Complete JSON
            </Button>
            <Button 
              variant="outline"
              onClick={() => {
                if (database) {
                  const url = `/api/databases/${database.id}/export-data?format=csv`;
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `${database.name}-complete-export.csv`;
                  a.click();
                  toast({ title: "Download started", description: "Complete database export (CSV)" });
                }
              }}
              data-testid="button-export-complete-csv"
            >
              <i className="fas fa-file-csv mr-2"></i>
              Complete CSV
            </Button>
          </div>
          <Button 
            onClick={runAllAnalysis}
            disabled={runAnalysis.isPending || runningJobs.length > 0}
            data-testid="button-run-analysis"
          >
            <i className="fas fa-play mr-2"></i>
            {runningJobs.length > 0 ? "Analysis Running..." : "Run Analysis"}
          </Button>
        </div>
      </div>
      
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Analysis Progress */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center">
              <i className="fas fa-chart-line mr-2"></i>
              Analysis Progress
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {/* Overall Progress */}
              <div>
                <div className="flex justify-between text-sm mb-2">
                  <span>Overall Completion</span>
                  <span className="text-primary" data-testid="text-overall-progress">
                    {summary ? `${Math.round((summary.analyzedColumns / summary.totalColumns) * 100)}%` : '0%'}
                  </span>
                </div>
                <Progress 
                  value={summary ? (summary.analyzedColumns / summary.totalColumns) * 100 : 0} 
                  className="h-2"
                  data-testid="progress-overall"
                />
              </div>

              {/* Individual Analysis Steps */}
              <div className="space-y-3">
                <div>
                  <div className="flex justify-between text-sm mb-2">
                    <span>Cardinality Analysis</span>
                    <span className={(summary?.analyzedColumns ?? 0) > 0 ? "text-emerald-600" : "text-muted-foreground"}>
                      {(summary?.analyzedColumns ?? 0) > 0 ? "Complete" : "Pending"}
                    </span>
                  </div>
                  <Progress 
                    value={(summary?.analyzedColumns ?? 0) > 0 ? 100 : 0} 
                    className="h-2"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-sm mb-2">
                    <span>Null Value Analysis</span>
                    <span className={(summary?.highNullColumns ?? -1) >= 0 ? "text-emerald-600" : "text-muted-foreground"}>
                      {(summary?.highNullColumns ?? -1) >= 0 ? "Complete" : "Pending"}
                    </span>
                  </div>
                  <Progress 
                    value={(summary?.highNullColumns ?? -1) >= 0 ? 100 : 0} 
                    className="h-2"
                  />
                </div>

                <div>
                  <div className="flex justify-between text-sm mb-2">
                    <span>Data Pattern Recognition</span>
                    <span className={summary?.patterns && summary.patterns.length > 0 ? "text-emerald-600" : "text-muted-foreground"}>
                      {summary?.patterns && summary.patterns.length > 0 ? "Complete" : "Pending"}
                    </span>
                  </div>
                  <Progress 
                    value={summary?.patterns && summary.patterns.length > 0 ? 100 : 0} 
                    className="h-2"
                  />
                </div>
              </div>

              {/* Current Activity */}
              {runningJobs.length > 0 && (
                <div className="mt-6 p-4 bg-blue-50 border border-blue-200 rounded-lg">
                  <div className="flex items-center">
                    <i className="fas fa-spinner fa-spin text-blue-600 mr-2"></i>
                    <div className="text-sm">
                      <p className="font-medium text-blue-800" data-testid="text-current-analysis">
                        Currently analyzing tables...
                      </p>
                      <p className="text-blue-600">
                        {runningJobs.length} job(s) in progress
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
        
        {/* Analysis Results */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center">
              <i className="fas fa-chart-bar mr-2"></i>
              Key Findings
            </CardTitle>
          </CardHeader>
          <CardContent>
            {!summary ? (
              <div className="text-center py-8 text-muted-foreground">
                Run analysis to see results
              </div>
            ) : (
              <div className="space-y-4">
                {/* Low Cardinality Columns */}
                {summary.lowCardinalityColumns > 0 && (
                  <div className="p-3 bg-emerald-50 border border-emerald-200 rounded-lg">
                    <div className="flex items-center mb-2">
                      <i className="fas fa-chart-bar text-emerald-600 mr-2"></i>
                      <span className="font-medium text-emerald-800">Low-Cardinality Columns</span>
                    </div>
                    <div className="text-sm text-emerald-700" data-testid="text-low-cardinality">
                      <p>• Found {summary.lowCardinalityColumns} columns suitable for enum values</p>
                      <p>• These will be expanded in the knowledge graph</p>
                    </div>
                  </div>
                )}

                {/* High Null Columns */}
                {summary.highNullColumns > 0 && (
                  <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg">
                    <div className="flex items-center mb-2">
                      <i className="fas fa-exclamation-triangle text-amber-600 mr-2"></i>
                      <span className="font-medium text-amber-800">High Null Percentage</span>
                    </div>
                    <div className="text-sm text-amber-700" data-testid="text-high-null">
                      <p>• {summary.highNullColumns} columns with {'>'} 40% null values</p>
                      <p>• May require SME clarification</p>
                    </div>
                  </div>
                )}

                {/* Join Candidates */}
                {summary.potentialJoinColumns > 0 && (
                  <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg">
                    <div className="flex items-center mb-2">
                      <i className="fas fa-link text-blue-600 mr-2"></i>
                      <span className="font-medium text-blue-800">Join Candidates</span>
                    </div>
                    <div className="text-sm text-blue-700" data-testid="text-join-candidates">
                      <p>• {summary.potentialJoinColumns} potential relationship columns</p>
                      <p>• Ready for semantic analysis</p>
                    </div>
                  </div>
                )}

                {/* Patterns */}
                {summary.patterns && summary.patterns.length > 0 && (
                  <div className="p-3 bg-purple-50 border border-purple-200 rounded-lg">
                    <div className="flex items-center mb-2">
                      <i className="fas fa-search text-purple-600 mr-2"></i>
                      <span className="font-medium text-purple-800">Data Patterns</span>
                    </div>
                    <div className="text-sm text-purple-700">
                      {summary.patterns.slice(0, 3).map((pattern, index) => (
                        <p key={index} data-testid={`text-pattern-${index}`}>• {pattern}</p>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Analysis Log */}
      {latestJob && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center">
              <i className="fas fa-terminal mr-2"></i>
              Analysis Log
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="bg-muted rounded-lg p-4 font-mono text-sm max-h-40 overflow-y-auto" data-testid="analysis-log">
              {latestJob.status === 'running' && (
                <>
                  <div className="text-blue-600">[{new Date().toLocaleTimeString()}] Statistical analysis started</div>
                  <div className="text-blue-600">[{new Date().toLocaleTimeString()}] Progress: {latestJob.progress}%</div>
                  <div className="text-blue-600">[{new Date().toLocaleTimeString()}] Analyzing column statistics...</div>
                </>
              )}
              {latestJob.status === 'completed' && (
                <>
                  <div className="text-emerald-600">[{new Date().toLocaleTimeString()}] Analysis completed successfully</div>
                  <div className="text-blue-600">[{new Date().toLocaleTimeString()}] Results stored in database</div>
                </>
              )}
              {latestJob.status === 'failed' && (
                <div className="text-red-600">[{new Date().toLocaleTimeString()}] Error: {latestJob.error}</div>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
