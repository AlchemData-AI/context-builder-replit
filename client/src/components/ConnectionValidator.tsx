import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

interface ConnectionStatus {
  postgresql: string;
  gemini: string;
  neo4j: string;
}

interface ConnectionValidatorProps {
  onConnectionStatus: (status: ConnectionStatus) => void;
}

interface Connection {
  id: string;
  name: string;
  type: string;
  status: string;
  lastTested?: string;
}

export default function ConnectionValidator({ onConnectionStatus }: ConnectionValidatorProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const [connections, setConnections] = useState({
    postgresql: { host: "", port: "5432", database: "", username: "", password: "" },
    gemini: { apiKey: "" },
    neo4j: { uri: "", username: "", password: "" }
  });

  // Fetch existing connections
  const { data: existingConnections = [] } = useQuery<Connection[]>({
    queryKey: ['/api/connections'],
    queryFn: async () => {
      const response = await fetch('/api/connections?userId=default-user');
      if (!response.ok) throw new Error('Failed to fetch connections');
      return response.json();
    }
  });

  // Create connection mutation
  const createConnection = useMutation({
    mutationFn: async (data: { name: string; type: string; config: any }) => {
      const response = await apiRequest('POST', '/api/connections', {
        ...data,
        userId: 'default-user'
      });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/connections'] });
      toast({ title: "Connection saved successfully" });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to save connection", description: error.message, variant: "destructive" });
    }
  });

  // Test connection mutation
  const testConnection = useMutation({
    mutationFn: async (connectionId: string) => {
      const response = await apiRequest('POST', `/api/connections/${connectionId}/test`);
      return response.json();
    },
    onSuccess: (result, connectionId) => {
      const connection = existingConnections.find(c => c.id === connectionId);
      if (connection) {
        toast({
          title: result.success ? "Connection successful" : "Connection failed",
          description: result.success 
            ? `Latency: ${result.latency}ms` 
            : result.error,
          variant: result.success ? "default" : "destructive"
        });
        
        // Update connection status
        onConnectionStatus({
          postgresql: connection.type === 'postgresql' ? (result.success ? 'connected' : 'failed') : 'pending',
          gemini: connection.type === 'gemini' ? (result.success ? 'connected' : 'failed') : 'pending',
          neo4j: connection.type === 'neo4j' ? (result.success ? 'connected' : 'failed') : 'pending'
        });
      }
      
      queryClient.invalidateQueries({ queryKey: ['/api/connections'] });
    },
    onError: (error: Error) => {
      toast({ title: "Connection test failed", description: error.message, variant: "destructive" });
    }
  });

  const handleConnectionSave = async (type: 'postgresql' | 'gemini' | 'neo4j') => {
    const config = connections[type];
    let connectionConfig: any;

    switch (type) {
      case 'postgresql':
        connectionConfig = {
          host: config.host,
          port: parseInt(config.port),
          database: config.database,
          user: config.username,
          password: config.password
        };
        break;
      case 'gemini':
        connectionConfig = {
          apiKey: config.apiKey
        };
        break;
      case 'neo4j':
        connectionConfig = {
          uri: config.uri,
          username: config.username,
          password: config.password
        };
        break;
    }

    createConnection.mutate({
      name: `${type}_connection`,
      type,
      config: connectionConfig
    });
  };

  const getConnectionByType = (type: string) => {
    return existingConnections.find(c => c.type === type);
  };

  const getStatusColor = (status?: string) => {
    switch (status) {
      case 'connected': return 'bg-emerald-500';
      case 'failed': return 'bg-red-500';
      default: return 'bg-amber-500';
    }
  };

  const getStatusBadge = (status?: string) => {
    switch (status) {
      case 'connected':
        return (
          <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3">
            <div className="flex items-center">
              <i className="fas fa-check-circle text-emerald-600 mr-2"></i>
              <div>
                <p className="text-sm font-medium text-emerald-800">Connection Successful</p>
                <p className="text-xs text-emerald-600">Ready for use</p>
              </div>
            </div>
          </div>
        );
      case 'failed':
        return (
          <div className="bg-red-50 border border-red-200 rounded-lg p-3">
            <div className="flex items-center">
              <i className="fas fa-times-circle text-red-600 mr-2"></i>
              <div>
                <p className="text-sm font-medium text-red-800">Connection Failed</p>
                <p className="text-xs text-red-600">Check configuration</p>
              </div>
            </div>
          </div>
        );
      default:
        return (
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
            <div className="flex items-center">
              <i className="fas fa-clock text-amber-600 mr-2"></i>
              <div>
                <p className="text-sm font-medium text-amber-800">Connection Pending</p>
                <p className="text-xs text-amber-600">Not tested yet</p>
              </div>
            </div>
          </div>
        );
    }
  };

  return (
    <div>
      <h2 className="text-2xl font-semibold mb-6" data-testid="connection-title">Connection Configuration</h2>
      
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* PostgreSQL Connection */}
        <Card data-testid="postgresql-connection-card">
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center">
                <i className="fas fa-database text-blue-500 mr-3"></i>
                <CardTitle className="text-lg">PostgreSQL</CardTitle>
              </div>
              <div className={`w-3 h-3 ${getStatusColor(getConnectionByType('postgresql')?.status)} rounded-full`}></div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-sm font-medium text-muted-foreground">Host</Label>
              <Input
                type="text"
                placeholder="localhost"
                value={connections.postgresql.host}
                onChange={(e) => setConnections(prev => ({
                  ...prev,
                  postgresql: { ...prev.postgresql, host: e.target.value }
                }))}
                data-testid="input-postgresql-host"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <Label className="text-sm font-medium text-muted-foreground">Port</Label>
                <Input
                  type="text"
                  placeholder="5432"
                  value={connections.postgresql.port}
                  onChange={(e) => setConnections(prev => ({
                    ...prev,
                    postgresql: { ...prev.postgresql, port: e.target.value }
                  }))}
                  data-testid="input-postgresql-port"
                />
              </div>
              <div>
                <Label className="text-sm font-medium text-muted-foreground">Database</Label>
                <Input
                  type="text"
                  placeholder="mydb"
                  value={connections.postgresql.database}
                  onChange={(e) => setConnections(prev => ({
                    ...prev,
                    postgresql: { ...prev.postgresql, database: e.target.value }
                  }))}
                  data-testid="input-postgresql-database"
                />
              </div>
            </div>
            <div>
              <Label className="text-sm font-medium text-muted-foreground">Username</Label>
              <Input
                type="text"
                placeholder="postgres"
                value={connections.postgresql.username}
                onChange={(e) => setConnections(prev => ({
                  ...prev,
                  postgresql: { ...prev.postgresql, username: e.target.value }
                }))}
                data-testid="input-postgresql-username"
              />
            </div>
            <div>
              <Label className="text-sm font-medium text-muted-foreground">Password</Label>
              <Input
                type="password"
                placeholder="password"
                value={connections.postgresql.password}
                onChange={(e) => setConnections(prev => ({
                  ...prev,
                  postgresql: { ...prev.postgresql, password: e.target.value }
                }))}
                data-testid="input-postgresql-password"
              />
            </div>
            
            {getStatusBadge(getConnectionByType('postgresql')?.status)}
            
            <div className="flex space-x-2">
              <Button
                onClick={() => handleConnectionSave('postgresql')}
                disabled={createConnection.isPending}
                className="flex-1"
                data-testid="button-save-postgresql"
              >
                {createConnection.isPending ? "Saving..." : "Save Connection"}
              </Button>
              {getConnectionByType('postgresql') && (
                <Button
                  onClick={() => testConnection.mutate(getConnectionByType('postgresql')!.id)}
                  disabled={testConnection.isPending}
                  variant="outline"
                  data-testid="button-test-postgresql"
                >
                  {testConnection.isPending ? "Testing..." : "Test"}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Gemini API Connection */}
        <Card data-testid="gemini-connection-card">
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center">
                <i className="fas fa-brain text-purple-500 mr-3"></i>
                <CardTitle className="text-lg">Gemini API</CardTitle>
              </div>
              <div className={`w-3 h-3 ${getStatusColor(getConnectionByType('gemini')?.status)} rounded-full`}></div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-sm font-medium text-muted-foreground">API Key</Label>
              <Input
                type="password"
                placeholder="AIza***************"
                value={connections.gemini.apiKey}
                onChange={(e) => setConnections(prev => ({
                  ...prev,
                  gemini: { ...prev.gemini, apiKey: e.target.value }
                }))}
                data-testid="input-gemini-apikey"
              />
            </div>
            
            {getStatusBadge(getConnectionByType('gemini')?.status)}
            
            <div className="text-xs text-muted-foreground">
              <p>Token limit: 8K per call</p>
              <p>Estimated cost: $0.12/1K tokens</p>
            </div>
            
            <div className="flex space-x-2">
              <Button
                onClick={() => handleConnectionSave('gemini')}
                disabled={createConnection.isPending}
                className="flex-1"
                data-testid="button-save-gemini"
              >
                {createConnection.isPending ? "Saving..." : "Save API Key"}
              </Button>
              {getConnectionByType('gemini') && (
                <Button
                  onClick={() => testConnection.mutate(getConnectionByType('gemini')!.id)}
                  disabled={testConnection.isPending}
                  variant="outline"
                  data-testid="button-test-gemini"
                >
                  {testConnection.isPending ? "Testing..." : "Test"}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Neo4j Connection */}
        <Card data-testid="neo4j-connection-card">
          <CardHeader className="pb-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center">
                <i className="fas fa-project-diagram text-green-500 mr-3"></i>
                <CardTitle className="text-lg">Neo4j</CardTitle>
              </div>
              <div className={`w-3 h-3 ${getStatusColor(getConnectionByType('neo4j')?.status)} rounded-full`}></div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <Label className="text-sm font-medium text-muted-foreground">Connection URI</Label>
              <Input
                type="text"
                placeholder="neo4j+s://xxx.databases.neo4j.io"
                value={connections.neo4j.uri}
                onChange={(e) => setConnections(prev => ({
                  ...prev,
                  neo4j: { ...prev.neo4j, uri: e.target.value }
                }))}
                data-testid="input-neo4j-uri"
              />
            </div>
            <div>
              <Label className="text-sm font-medium text-muted-foreground">Username</Label>
              <Input
                type="text"
                placeholder="neo4j"
                value={connections.neo4j.username}
                onChange={(e) => setConnections(prev => ({
                  ...prev,
                  neo4j: { ...prev.neo4j, username: e.target.value }
                }))}
                data-testid="input-neo4j-username"
              />
            </div>
            <div>
              <Label className="text-sm font-medium text-muted-foreground">Password</Label>
              <Input
                type="password"
                placeholder="password"
                value={connections.neo4j.password}
                onChange={(e) => setConnections(prev => ({
                  ...prev,
                  neo4j: { ...prev.neo4j, password: e.target.value }
                }))}
                data-testid="input-neo4j-password"
              />
            </div>
            
            {getStatusBadge(getConnectionByType('neo4j')?.status)}
            
            <div className="text-xs text-muted-foreground">
              <p>Database: alchemdata_mvp</p>
              <p>Namespace: /context_builder</p>
            </div>
            
            <div className="flex space-x-2">
              <Button
                onClick={() => handleConnectionSave('neo4j')}
                disabled={createConnection.isPending}
                className="flex-1"
                data-testid="button-save-neo4j"
              >
                {createConnection.isPending ? "Saving..." : "Save Connection"}
              </Button>
              {getConnectionByType('neo4j') && (
                <Button
                  onClick={() => testConnection.mutate(getConnectionByType('neo4j')!.id)}
                  disabled={testConnection.isPending}
                  variant="outline"
                  data-testid="button-test-neo4j"
                >
                  {testConnection.isPending ? "Testing..." : "Test"}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
