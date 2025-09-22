import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface Table {
  id: string;
  name: string;
  rowCount: number;
  isSelected: boolean;
  sampleSize: number;
}

export default function SamplingConfiguration() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [globalSampleSize, setGlobalSampleSize] = useState([10000]);
  const [tableSampleSizes, setTableSampleSizes] = useState<Record<string, number>>({});

  // Get PostgreSQL connection and database
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
  const { data: tables = [] } = useQuery<Table[]>({
    queryKey: ['/api/databases', database?.id, 'tables'],
    queryFn: async () => {
      if (!database) return [];
      const response = await fetch(`/api/databases/${database.id}/tables`);
      return response.json();
    },
    enabled: !!database
  });

  const selectedTables = tables.filter(t => t.isSelected);

  // Update table sample size mutation
  const updateSampleSize = useMutation({
    mutationFn: async ({ tableId, sampleSize }: { tableId: string; sampleSize: number }) => {
      const response = await apiRequest('POST', `/api/tables/${tableId}/select`, {
        isSelected: true,
        sampleSize
      });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/databases', database?.id, 'tables'] });
    }
  });

  const calculateRecommendedSampleSize = (rowCount: number): number => {
    if (rowCount > 1000000) return 10000;
    if (rowCount > 100000) return 5000;
    if (rowCount > 10000) return 1000;
    return Math.min(rowCount, 1000);
  };

  const getSamplingStrategy = (rowCount: number, sampleSize: number): string => {
    if (sampleSize >= rowCount) return "Full table";
    if (sampleSize >= rowCount * 0.8) return "Large sample";
    if (rowCount > 1000000) return "Recent data";
    return "Random sample";
  };

  const getStrategyColor = (strategy: string): string => {
    switch (strategy) {
      case "Full table": return "bg-gray-100 text-gray-800";
      case "Recent data": return "bg-emerald-100 text-emerald-800";
      case "Random sample": return "bg-blue-100 text-blue-800";
      default: return "bg-amber-100 text-amber-800";
    }
  };

  const handleGlobalSampleSizeChange = (value: number[]) => {
    setGlobalSampleSize(value);
    const newSize = value[0];
    
    // Update all table sample sizes to the global value
    const updates: Record<string, number> = {};
    selectedTables.forEach(table => {
      const recommended = Math.min(newSize, table.rowCount);
      updates[table.id] = recommended;
      updateSampleSize.mutate({ tableId: table.id, sampleSize: recommended });
    });
    setTableSampleSizes(prev => ({ ...prev, ...updates }));
  };

  const handleTableSampleSizeChange = (tableId: string, newSize: number) => {
    setTableSampleSizes(prev => ({ ...prev, [tableId]: newSize }));
    updateSampleSize.mutate({ tableId, sampleSize: newSize });
  };

  const estimateTokens = (): number => {
    let totalTokens = 0;
    selectedTables.forEach(table => {
      const sampleSize = tableSampleSizes[table.id] || table.sampleSize;
      // Rough estimation: each row might generate ~50 tokens on average
      totalTokens += sampleSize * 50;
    });
    return totalTokens;
  };

  const estimateCost = (): number => {
    const tokens = estimateTokens();
    // Gemini pricing: approximately $0.0005 per 1K tokens
    return (tokens / 1000) * 0.0005;
  };

  if (!postgresConnection || selectedTables.length === 0) {
    return (
      <div className="text-center py-8">
        <p className="text-muted-foreground">
          {!postgresConnection 
            ? "Please configure your PostgreSQL connection first." 
            : "Please select tables in Schema Overview first."}
        </p>
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-2xl font-semibold mb-6" data-testid="sampling-title">Intelligent Sampling Configuration</h2>
      
      <Card>
        <CardContent className="p-6">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Smart Defaults */}
            <div>
              <h3 className="text-lg font-medium mb-4" data-testid="smart-defaults-title">Smart Defaults</h3>
              <div className="space-y-4">
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
                  <div className="flex items-center mb-3">
                    <i className="fas fa-lightbulb text-blue-600 mr-2"></i>
                    <span className="font-medium text-blue-800">AI Recommendations</span>
                  </div>
                  <div className="space-y-2 text-sm">
                    <p className="text-blue-700">• Large tables ({'>'} 1M rows): Sample 10K rows</p>
                    <p className="text-blue-700">• Medium tables (100K-1M rows): Sample 5K rows</p>
                    <p className="text-blue-700">• Small tables ({'<'} 100K rows): Sample all rows</p>
                    <p className="text-blue-700">• Prioritize recent data (last 30 days)</p>
                  </div>
                </div>
                
                <div>
                  <label className="text-sm font-medium text-muted-foreground block mb-2">
                    Global Row Limit
                  </label>
                  <div className="space-y-3">
                    <Slider
                      value={globalSampleSize}
                      onValueChange={handleGlobalSampleSizeChange}
                      min={1000}
                      max={50000}
                      step={1000}
                      className="flex-1"
                      data-testid="slider-global-sample-size"
                    />
                    <div className="flex items-center justify-between">
                      <span className="text-sm text-muted-foreground">1K</span>
                      <span className="bg-secondary px-3 py-1 rounded text-sm font-medium" data-testid="text-current-global-size">
                        {globalSampleSize[0].toLocaleString()}
                      </span>
                      <span className="text-sm text-muted-foreground">50K</span>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    Recommended for optimal Gemini API usage
                  </p>
                </div>
              </div>
            </div>
            
            {/* Table-Specific Configuration */}
            <div>
              <h3 className="text-lg font-medium mb-4" data-testid="table-config-title">Table-Specific Configuration</h3>
              <div className="space-y-3 max-h-96 overflow-y-auto">
                {selectedTables.map(table => {
                  const currentSampleSize = tableSampleSizes[table.id] || table.sampleSize;
                  const recommendedSize = calculateRecommendedSampleSize(table.rowCount);
                  const strategy = getSamplingStrategy(table.rowCount, currentSampleSize);
                  
                  return (
                    <div 
                      key={table.id} 
                      className="bg-accent rounded-lg p-3"
                      data-testid={`table-config-${table.name}`}
                    >
                      <div className="flex items-center justify-between mb-2">
                        <span className="font-medium">{table.name}</span>
                        <span className="text-xs text-muted-foreground">
                          {table.rowCount.toLocaleString()} rows
                        </span>
                      </div>
                      <div className="flex items-center space-x-3 mb-2">
                        <Input
                          type="number"
                          value={currentSampleSize}
                          onChange={(e) => {
                            const newSize = Math.max(1, Math.min(table.rowCount, parseInt(e.target.value) || 0));
                            handleTableSampleSizeChange(table.id, newSize);
                          }}
                          className="w-20"
                          min="1"
                          max={table.rowCount}
                          data-testid={`input-sample-size-${table.name}`}
                        />
                        <span className="text-sm text-muted-foreground">rows</span>
                        <span className={`px-2 py-1 rounded text-xs ${getStrategyColor(strategy)}`}>
                          {strategy}
                        </span>
                      </div>
                      {currentSampleSize !== recommendedSize && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleTableSampleSizeChange(table.id, recommendedSize)}
                          className="text-xs"
                          data-testid={`button-use-recommended-${table.name}`}
                        >
                          Use recommended ({recommendedSize.toLocaleString()})
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
          
          {/* Cost Estimation */}
          <div className="mt-6 pt-6 border-t border-border">
            <div className="flex items-center justify-between">
              <div className="text-sm text-muted-foreground" data-testid="cost-estimation">
                Estimated tokens: ~{Math.round(estimateTokens() / 1000)}K | Cost: ${estimateCost().toFixed(2)}
              </div>
              <Button 
                onClick={() => {
                  toast({ 
                    title: "Configuration applied", 
                    description: `Sampling configured for ${selectedTables.length} tables` 
                  });
                }}
                data-testid="button-apply-configuration"
              >
                Apply Configuration
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
