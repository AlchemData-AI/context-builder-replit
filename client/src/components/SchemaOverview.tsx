import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";

interface Table {
  id: string;
  name: string;
  schema: string;
  rowCount: number;
  columnCount: number;
  lastUpdated?: string;
  isSelected: boolean;
  sampleSize: number;
}

interface Database {
  id: string;
  name: string;
  schema: string;
  connectionId: string;
}

export default function SchemaOverview() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedSchema, setSelectedSchema] = useState("all");
  const [selectedTables, setSelectedTables] = useState<string[]>([]);
  const [currentDatabase, setCurrentDatabase] = useState<string>("");
  const [showSchemaDialog, setShowSchemaDialog] = useState(false);
  const [selectedSchemaForCreation, setSelectedSchemaForCreation] = useState<string>("");

  // Fetch connections to get PostgreSQL connection
  const { data: connections = [] } = useQuery({
    queryKey: ['/api/connections'],
    queryFn: async () => {
      const response = await fetch('/api/connections?userId=default-user');
      if (!response.ok) throw new Error('Failed to fetch connections');
      return response.json();
    }
  });

  const postgresConnection = connections.find((c: any) => c.type === 'postgresql' && c.status === 'connected');

  // Fetch available schemas for the PostgreSQL connection
  const { data: availableSchemas = [] } = useQuery({
    queryKey: ['/api/connections', postgresConnection?.id, 'schemas'],
    queryFn: async () => {
      if (!postgresConnection) return [];
      const response = await fetch(`/api/connections/${postgresConnection.id}/schemas`);
      if (!response.ok) throw new Error('Failed to fetch schemas');
      const data = await response.json();
      return data.schemas || [];
    },
    enabled: !!postgresConnection
  });

  // Fetch databases for the PostgreSQL connection
  const { data: databases = [] } = useQuery({
    queryKey: ['/api/databases', postgresConnection?.id],
    queryFn: async () => {
      if (!postgresConnection) return [];
      const response = await fetch(`/api/databases?connectionId=${postgresConnection.id}`);
      if (!response.ok) throw new Error('Failed to fetch databases');
      return response.json();
    },
    enabled: !!postgresConnection
  });

  // Use the first database or create one if none exists
  const database = databases[0] || null;

  // Fetch tables for the selected database
  const { data: tables = [], isLoading: tablesLoading } = useQuery<Table[]>({
    queryKey: ['/api/databases', database?.id, 'tables'],
    queryFn: async () => {
      if (!database) return [];
      const response = await fetch(`/api/databases/${database.id}/tables`);
      if (!response.ok) throw new Error('Failed to fetch tables');
      return response.json();
    },
    enabled: !!database
  });

  // Schema analysis mutation
  const analyzeSchema = useMutation({
    mutationFn: async (databaseId: string) => {
      const response = await apiRequest('POST', `/api/databases/${databaseId}/analyze-schema`);
      return response.json();
    },
    onSuccess: (data) => {
      toast({ 
        title: "Schema analysis completed", 
        description: `Found ${data.totalTables} tables with ${data.totalColumns} columns` 
      });
      queryClient.invalidateQueries({ queryKey: ['/api/databases', database?.id, 'tables'] });
    },
    onError: (error: Error) => {
      toast({ title: "Schema analysis failed", description: error.message, variant: "destructive" });
    }
  });

  // Create database with selected schema
  const createDatabase = useMutation({
    mutationFn: async (schema: string) => {
      if (!postgresConnection) throw new Error('No PostgreSQL connection');
      const response = await apiRequest('POST', '/api/databases', {
        connectionId: postgresConnection.id,
        name: 'default',
        schema: schema
      });
      return response.json();
    },
    onSuccess: (database) => {
      queryClient.invalidateQueries({ queryKey: ['/api/databases'] });
      setShowSchemaDialog(false);
      toast({ 
        title: "Database created", 
        description: `Database created with schema: ${selectedSchemaForCreation}` 
      });
      // Automatically trigger schema analysis after database creation
      setTimeout(() => {
        analyzeSchema.mutate(database.id);
      }, 500);
    },
    onError: (error: Error) => {
      toast({ title: "Database creation failed", description: error.message, variant: "destructive" });
    }
  });

  // Table selection mutation
  const updateTableSelection = useMutation({
    mutationFn: async ({ tableId, isSelected, sampleSize }: { tableId: string; isSelected: boolean; sampleSize?: number }) => {
      const response = await apiRequest('POST', `/api/tables/${tableId}/select`, {
        isSelected,
        sampleSize
      });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/databases', database?.id, 'tables'] });
    }
  });

  const handleTableSelection = (tableId: string, isSelected: boolean) => {
    updateTableSelection.mutate({ tableId, isSelected });
    
    if (isSelected) {
      setSelectedTables(prev => [...prev, tableId]);
    } else {
      setSelectedTables(prev => prev.filter(id => id !== tableId));
    }
  };

  const handleRefreshSchema = () => {
    if (database) {
      analyzeSchema.mutate(database.id);
    } else if (postgresConnection) {
      // Show schema selection dialog
      if (availableSchemas.length > 1) {
        setShowSchemaDialog(true);
      } else if (availableSchemas.length === 1) {
        // Only one schema available, use it directly
        setSelectedSchemaForCreation(availableSchemas[0]);
        createDatabase.mutate(availableSchemas[0]);
      } else {
        // Fallback to public if no schemas found
        setSelectedSchemaForCreation('public');
        createDatabase.mutate('public');
      }
    }
  };

  const handleCreateDatabaseWithSchema = () => {
    if (selectedSchemaForCreation) {
      createDatabase.mutate(selectedSchemaForCreation);
    }
  };

  const filteredTables = tables.filter(table => {
    const matchesSearch = table.name.toLowerCase().includes(searchTerm.toLowerCase());
    const matchesSchema = selectedSchema === "all" || table.schema === selectedSchema;
    return matchesSearch && matchesSchema;
  });

  const uniqueSchemas = Array.from(new Set(tables.map(t => t.schema)));
  const activeTables = tables.filter(t => t.rowCount > 0);
  const totalColumns = tables.reduce((sum, t) => sum + t.columnCount, 0);
  const selectedTablesCount = tables.filter(t => t.isSelected).length;

  if (!postgresConnection) {
    return (
      <div className="text-center py-8">
        <p className="text-muted-foreground">Please configure and test your PostgreSQL connection first.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-semibold" data-testid="schema-title">Database Schema Overview</h2>
        <Button 
          onClick={handleRefreshSchema}
          disabled={analyzeSchema.isPending || createDatabase.isPending}
          data-testid="button-refresh-schema"
        >
          <i className="fas fa-sync-alt mr-2"></i>
          {analyzeSchema.isPending ? "Analyzing..." : "Refresh Schema"}
        </Button>
      </div>
      
      <Card>
        <CardContent className="p-6">
          {/* Statistics */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6 p-6 border-b border-border">
            <div className="text-center" data-testid="stat-total-tables">
              <div className="text-2xl font-bold text-primary">{tables.length}</div>
              <div className="text-sm text-muted-foreground">Total Tables</div>
            </div>
            <div className="text-center" data-testid="stat-active-tables">
              <div className="text-2xl font-bold text-emerald-600">{activeTables.length}</div>
              <div className="text-sm text-muted-foreground">Active Tables</div>
            </div>
            <div className="text-center" data-testid="stat-total-columns">
              <div className="text-2xl font-bold text-amber-600">{totalColumns}</div>
              <div className="text-sm text-muted-foreground">Total Columns</div>
            </div>
            <div className="text-center" data-testid="stat-selected-tables">
              <div className="text-2xl font-bold text-blue-600">{selectedTablesCount}</div>
              <div className="text-sm text-muted-foreground">Selected Tables</div>
            </div>
          </div>
          
          {/* Filters */}
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center space-x-3">
              <Input
                type="text"
                placeholder="Search tables..."
                className="w-64"
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                data-testid="input-search-tables"
              />
              <Select value={selectedSchema} onValueChange={setSelectedSchema}>
                <SelectTrigger className="w-40" data-testid="select-schema-filter">
                  <SelectValue placeholder="All Schemas" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Schemas</SelectItem>
                  {uniqueSchemas.map(schema => (
                    <SelectItem key={schema} value={schema}>{schema}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="text-sm text-muted-foreground" data-testid="text-showing-tables">
              Showing {filteredTables.length} of {tables.length} tables
            </div>
          </div>
          
          {/* Table List */}
          {tablesLoading ? (
            <div className="text-center py-8" data-testid="tables-loading">
              <p className="text-muted-foreground">Loading tables...</p>
            </div>
          ) : filteredTables.length === 0 ? (
            <div className="text-center py-8" data-testid="no-tables">
              <p className="text-muted-foreground">
                {tables.length === 0 ? 'No tables found. Please refresh schema.' : 'No tables match your filters.'}
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full" data-testid="tables-table">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left py-3 px-4 font-medium text-sm">
                      <Checkbox 
                        checked={selectedTables.length === filteredTables.length}
                        onCheckedChange={(checked) => {
                          if (checked) {
                            const newSelections = filteredTables.filter(t => !t.isSelected);
                            newSelections.forEach(t => handleTableSelection(t.id, true));
                          } else {
                            const currentSelections = filteredTables.filter(t => t.isSelected);
                            currentSelections.forEach(t => handleTableSelection(t.id, false));
                          }
                        }}
                        data-testid="checkbox-select-all-tables"
                      />
                    </th>
                    <th className="text-left py-3 px-4 font-medium text-sm">Table Name</th>
                    <th className="text-left py-3 px-4 font-medium text-sm">Rows</th>
                    <th className="text-left py-3 px-4 font-medium text-sm">Columns</th>
                    <th className="text-left py-3 px-4 font-medium text-sm">Schema</th>
                    <th className="text-left py-3 px-4 font-medium text-sm">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredTables.map((table) => (
                    <tr key={table.id} className="hover:bg-accent/50" data-testid={`table-row-${table.name}`}>
                      <td className="py-3 px-4">
                        <Checkbox
                          checked={table.isSelected}
                          onCheckedChange={(checked) => handleTableSelection(table.id, !!checked)}
                          data-testid={`checkbox-table-${table.name}`}
                        />
                      </td>
                      <td className="py-3 px-4">
                        <div className="flex items-center">
                          <i className="fas fa-table text-blue-500 mr-2"></i>
                          <span className="font-medium">{table.name}</span>
                        </div>
                      </td>
                      <td className="py-3 px-4 text-sm" data-testid={`text-rows-${table.name}`}>
                        {table.rowCount.toLocaleString()}
                      </td>
                      <td className="py-3 px-4 text-sm" data-testid={`text-columns-${table.name}`}>
                        {table.columnCount}
                      </td>
                      <td className="py-3 px-4 text-sm">{table.schema}</td>
                      <td className="py-3 px-4">
                        <span 
                          className={`px-2 py-1 rounded text-xs ${
                            table.rowCount > 0 
                              ? 'bg-emerald-100 text-emerald-800' 
                              : 'bg-amber-100 text-amber-800'
                          }`}
                        >
                          {table.rowCount > 0 ? 'Active' : 'Empty'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          
          {/* Action Bar */}
          {selectedTablesCount > 0 && (
            <div className="flex items-center justify-between mt-4 pt-4 border-t border-border">
              <Button 
                onClick={() => {
                  // This will be handled in the next step (Statistical Analysis)
                  toast({ title: "Analysis queued", description: `${selectedTablesCount} tables selected for analysis` });
                }}
                data-testid="button-analyze-selected"
              >
                Analyze Selected Tables ({selectedTablesCount})
              </Button>
              
              {/* Download buttons */}
              <div className="flex space-x-2">
                <Button 
                  variant="outline" 
                  onClick={() => {
                    if (database) {
                      const url = `/api/databases/${database.id}/export-data?format=json`;
                      const a = document.createElement('a');
                      a.href = url;
                      a.download = `${database.name}-complete-export.json`;
                      a.click();
                      toast({ title: "Download started", description: "Complete database analysis (JSON format)" });
                    }
                  }}
                  data-testid="button-download-json"
                >
                  <i className="fas fa-download mr-2"></i>
                  Download JSON
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
                      toast({ title: "Download started", description: "Complete database analysis (CSV format)" });
                    }
                  }}
                  data-testid="button-download-csv"
                >
                  <i className="fas fa-file-csv mr-2"></i>
                  Download CSV
                </Button>
              </div>
              <div className="text-sm text-muted-foreground">
                Use Ctrl+Click to select multiple tables
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Schema Selection Dialog */}
      <Dialog open={showSchemaDialog} onOpenChange={setShowSchemaDialog}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Select Database Schema</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Multiple schemas were found in your database. Please select which schema contains the tables you want to analyze:
            </p>
            <Select value={selectedSchemaForCreation} onValueChange={setSelectedSchemaForCreation}>
              <SelectTrigger data-testid="select-schema-creation">
                <SelectValue placeholder="Choose a schema..." />
              </SelectTrigger>
              <SelectContent>
                {availableSchemas.map((schema: string) => (
                  <SelectItem key={schema} value={schema}>
                    {schema}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex justify-end space-x-2">
              <Button 
                variant="outline" 
                onClick={() => setShowSchemaDialog(false)}
                data-testid="button-cancel-schema"
              >
                Cancel
              </Button>
              <Button 
                onClick={handleCreateDatabaseWithSchema}
                disabled={!selectedSchemaForCreation || createDatabase.isPending}
                data-testid="button-create-with-schema"
              >
                {createDatabase.isPending ? "Creating..." : "Create Database"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
