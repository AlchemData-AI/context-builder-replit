import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
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
  databaseId: string;
  type: string;
  status: string;
  progress: number;
  result?: any;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  createdAt?: string;
  totalUnits?: number;
  completedUnits?: number;
  processedTableIds?: string[];
  lastError?: string;
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
  const queryClient = useQueryClient();
  const [currentAnalysis, setCurrentAnalysis] = useState<AnalysisJob | null>(null);

  // Get database
  const { data: connections } = useQuery({
    queryKey: ['/api/connections'],
    queryFn: async () => {
      const response = await fetch('/api/connections?userId=default-user');
      return response.json();
    }
  });

  const connectionsList = Array.isArray(connections) ? connections : [];
  const postgresConnection = connectionsList.find((c: any) => c.type === 'postgresql' && c.status === 'connected');

  const { data: databases } = useQuery({
    queryKey: ['/api/databases', postgresConnection?.id],
    queryFn: async () => {
      if (!postgresConnection) return [];
      const response = await fetch(`/api/databases?connectionId=${postgresConnection.id}`);
      return response.json();
    },
    enabled: !!postgresConnection
  });

  const databasesList = Array.isArray(databases) ? databases : [];
  const database = databasesList[0];

  // Fetch selected tables
  const { data: tables } = useQuery({
    queryKey: ['/api/databases', database?.id, 'tables'],
    queryFn: async () => {
      if (!database) return [];
      const response = await fetch(`/api/databases/${database.id}/tables`);
      return response.json();
    },
    enabled: !!database
  });

  const tablesList = Array.isArray(tables) ? tables : [];
  const selectedTables = tablesList.filter((t: any) => t.isSelected);

  // Calculate aggregate sample stats
  const totalSamplesAnalyzed = selectedTables.reduce((sum: number, t: any) => sum + (t.samplesAnalyzed || 0), 0);
  const avgSamplesPerTable = selectedTables.length > 0 ? Math.round(totalSamplesAnalyzed / selectedTables.length) : 0;

  // Get sample strategy text
  const getSampleStrategyText = (samplesAnalyzed: number) => {
    if (samplesAnalyzed === 0) return 'Top 1K';
    if (samplesAnalyzed === 1) return 'Bottom 1K';
    return `Random 1K #${samplesAnalyzed - 1}`;
  };

  const nextSampleStrategy = selectedTables.length > 0
    ? getSampleStrategyText(selectedTables[0].samplesAnalyzed || 0)
    : 'Top 1K';

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

  // Clear all jobs mutation
  const clearJobs = useMutation({
    mutationFn: async () => {
      if (!database?.id) throw new Error('Database not found');
      const response = await apiRequest('DELETE', `/api/databases/${database.id}/jobs?type=statistical`);
      return response.json();
    },
    onSuccess: () => {
      setCurrentAnalysis(null);
      if (database?.id) {
        queryClient.invalidateQueries({ queryKey: ['/api/databases', database.id, 'jobs'] });
      }
      toast({ title: "Jobs cleared", description: "All statistical analysis jobs have been removed" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to clear jobs", description: error.message, variant: "destructive" });
    }
  });

  // Reset analysis mutation (clear jobs + reset sample counts)
  const resetAnalysis = useMutation({
    mutationFn: async () => {
      if (!database?.id) throw new Error('Database not found');
      const response = await apiRequest('POST', `/api/databases/${database.id}/reset-analysis`);
      return response.json();
    },
    onSuccess: () => {
      setCurrentAnalysis(null);
      if (database?.id) {
        queryClient.invalidateQueries({ queryKey: ['/api/databases', database.id, 'jobs'] });
        queryClient.invalidateQueries({ queryKey: ['/api/databases', database.id, 'tables'] });
        queryClient.invalidateQueries({ queryKey: ['/api/databases', database.id, 'statistical-summary'] });
      }
      toast({
        title: "Analysis reset",
        description: "All jobs cleared and sample counts reset to 0"
      });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to reset analysis", description: error.message, variant: "destructive" });
    }
  });

  const jobsList = Array.isArray(jobs) ? jobs : [];
  const statisticalJobs = jobsList.filter(j => j.type === 'statistical');
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
          <div className="flex items-center space-x-2">
            {avgSamplesPerTable > 0 && (
              <div className="flex items-center space-x-2 px-3 py-1 bg-blue-50 border border-blue-200 rounded text-sm text-blue-700">
                <i className="fas fa-database"></i>
                <span>Samples: {avgSamplesPerTable}</span>
              </div>
            )}
            {statisticalJobs.length > 0 && (
              <Button
                variant="outline"
                onClick={() => clearJobs.mutate()}
                disabled={clearJobs.isPending}
                data-testid="button-clear-jobs"
              >
                <i className="fas fa-trash-alt mr-2"></i>
                Clear Jobs
              </Button>
            )}
            {avgSamplesPerTable > 0 && (
              <Button
                variant="outline"
                onClick={() => resetAnalysis.mutate()}
                disabled={resetAnalysis.isPending || runningJobs.length > 0}
                data-testid="button-reset-analysis"
              >
                <i className="fas fa-redo mr-2"></i>
                Reset Analysis
              </Button>
            )}
            <Button
              onClick={runAllAnalysis}
              disabled={runAnalysis.isPending || runningJobs.length > 0}
              data-testid="button-run-analysis"
            >
              <i className="fas fa-play mr-2"></i>
              {runningJobs.length > 0 ? "Analysis Running..." : `Analyze ${nextSampleStrategy}`}
            </Button>
          </div>
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
                  <div>
                    <div className="flex items-center mb-2">
                      <i className="fas fa-spinner fa-spin text-blue-600 mr-2"></i>
                      <p className="font-medium text-blue-800" data-testid="text-current-analysis">
                        Active Analysis ({runningJobs.length} {runningJobs.length === 1 ? 'job' : 'jobs'})
                      </p>
                    </div>
                    <div className="space-y-2">
                      {runningJobs.map((job, idx) => {
                        const tableName = job.result?.tableName || 'Unknown table';
                        const schema = job.result?.schema || 'public';
                        return (
                          <div key={job.id} className="flex items-center text-sm text-blue-700">
                            <i className="fas fa-table mr-2 text-xs"></i>
                            <span className="font-semibold">{schema}.{tableName}</span>
                            <span className="mx-2">•</span>
                            <span>{job.progress}% complete</span>
                            {job.result?.analyzedColumns !== undefined && (
                              <>
                                <span className="mx-2">•</span>
                                <span>{job.result.analyzedColumns}/{job.result.totalColumns} columns</span>
                              </>
                            )}
                          </div>
                        );
                      })}
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
                {/* Sampling Info */}
                {avgSamplesPerTable > 0 && (
                  <div className="p-3 bg-indigo-50 border border-indigo-200 rounded-lg">
                    <div className="flex items-center mb-2">
                      <i className="fas fa-vial text-indigo-600 mr-2"></i>
                      <span className="font-medium text-indigo-800">Sample Analysis</span>
                    </div>
                    <div className="text-sm text-indigo-700">
                      <p>• {avgSamplesPerTable} sample{avgSamplesPerTable > 1 ? 's' : ''} analyzed per table (1K rows each)</p>
                      <p>• Click "Analyze {nextSampleStrategy}" to run next sample</p>
                      {selectedTables.length > 0 && selectedTables[0].lastSampleStrategy && (
                        <p>• Last sample: {selectedTables[0].lastSampleStrategy.replace('_', ' offset ')}</p>
                      )}
                    </div>
                  </div>
                )}

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

      {/* Running Jobs Details */}
      {statisticalJobs.length > 0 && (
        <Card className="mt-6">
          <CardHeader>
            <CardTitle className="flex items-center justify-between">
              <div className="flex items-center">
                <i className="fas fa-tasks mr-2"></i>
                Job Details
              </div>
              <span className="text-sm font-normal text-muted-foreground">
                {runningJobs.length} running · {statisticalJobs.filter(j => j.status === 'completed').length} completed · {statisticalJobs.filter(j => j.status === 'failed').length} failed
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-3 max-h-96 overflow-y-auto">
              {statisticalJobs.slice(0, 10).map((job) => {
                const tableName = job.result?.tableName || 'Unknown table';
                const tableId = job.result?.tableId || '';
                const schema = job.result?.schema || 'public';
                const sqlQuery = job.result?.sqlQuery || '';
                const isRunning = job.status === 'running';
                const isCompleted = job.status === 'completed';
                const isFailed = job.status === 'failed';

                return (
                  <div
                    key={job.id}
                    className={`p-4 rounded-lg border ${
                      isRunning ? 'bg-blue-50 border-blue-200' :
                      isCompleted ? 'bg-emerald-50 border-emerald-200' :
                      isFailed ? 'bg-red-50 border-red-200' :
                      'bg-gray-50 border-gray-200'
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-3">
                          {isRunning && <i className="fas fa-spinner fa-spin text-blue-600 text-lg"></i>}
                          {isCompleted && <i className="fas fa-check-circle text-emerald-600 text-lg"></i>}
                          {isFailed && <i className="fas fa-times-circle text-red-600 text-lg"></i>}
                          <div className="flex flex-col">
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-base">
                                {schema}.{tableName}
                              </span>
                              <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                                isRunning ? 'bg-blue-100 text-blue-700' :
                                isCompleted ? 'bg-emerald-100 text-emerald-700' :
                                isFailed ? 'bg-red-100 text-red-700' :
                                'bg-gray-100 text-gray-700'
                              }`}>
                                {job.status}
                              </span>
                            </div>
                            {isRunning && (
                              <span className="text-xs text-blue-600 font-semibold mt-1">
                                🔄 Currently analyzing this table...
                              </span>
                            )}
                          </div>
                        </div>

                        {sqlQuery && (
                          <div className="mb-3 p-3 bg-gray-900 rounded border border-gray-700">
                            <div className="flex items-center justify-between mb-1">
                              <span className="text-xs font-semibold text-gray-400 uppercase">SQL Query</span>
                              <button
                                onClick={() => {
                                  navigator.clipboard.writeText(sqlQuery);
                                  toast({ title: "Copied!", description: "SQL query copied to clipboard" });
                                }}
                                className="text-xs text-gray-400 hover:text-gray-200 transition-colors"
                              >
                                <i className="fas fa-copy"></i> Copy
                              </button>
                            </div>
                            <code className="text-xs text-green-400 font-mono block overflow-x-auto">
                              {sqlQuery}
                            </code>
                          </div>
                        )}

                        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground font-mono">
                          <div>
                            <span className="font-semibold">Job ID:</span> {job.id.substring(0, 8)}...
                          </div>
                          <div>
                            <span className="font-semibold">Progress:</span> {job.progress}%
                          </div>
                          {tableId && (
                            <div>
                              <span className="font-semibold">Table ID:</span> {tableId.substring(0, 8)}...
                            </div>
                          )}
                          {job.startedAt && (
                            <div>
                              <span className="font-semibold">Started:</span> {new Date(job.startedAt).toLocaleTimeString()}
                            </div>
                          )}
                          {job.completedAt && (
                            <div>
                              <span className="font-semibold">Completed:</span> {new Date(job.completedAt).toLocaleTimeString()}
                            </div>
                          )}
                          {job.totalUnits && job.totalUnits > 0 && (
                            <div>
                              <span className="font-semibold">Units:</span> {job.completedUnits || 0}/{job.totalUnits}
                            </div>
                          )}
                        </div>

                        {job.result?.analyzedColumns !== undefined && (
                          <div className="mt-2 text-xs text-muted-foreground">
                            <span className="font-semibold">Analyzed:</span> {job.result.analyzedColumns}/{job.result.totalColumns} columns
                            {job.result.sampleStrategy && (
                              <span className="ml-3">
                                <span className="font-semibold">Sample:</span> {job.result.sampleStrategy}
                                {job.result.sampleOffset !== undefined && ` (offset: ${job.result.sampleOffset})`}
                                {job.result.sampleSize && ` - ${job.result.sampleSize} rows`}
                              </span>
                            )}
                          </div>
                        )}

                        {job.error && (
                          <div className="mt-2 p-2 bg-red-100 border border-red-200 rounded text-xs text-red-800 font-mono">
                            <span className="font-semibold">Error:</span> {job.error}
                          </div>
                        )}

                        {job.lastError && job.lastError !== job.error && (
                          <div className="mt-2 p-2 bg-orange-100 border border-orange-200 rounded text-xs text-orange-800 font-mono">
                            <span className="font-semibold">Last Error:</span> {job.lastError}
                          </div>
                        )}
                      </div>
                    </div>

                    {isRunning && (
                      <div className="mt-3">
                        <Progress value={job.progress} className="h-1.5" />
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
