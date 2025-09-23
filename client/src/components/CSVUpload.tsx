import { useState, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Upload, FileText, CheckCircle, AlertCircle, Network, Users, Plus, X } from "lucide-react";
import { useMutation, useQueryClient, useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

interface CSVUploadProps {
  databaseId: string;
  onUploadComplete?: (progress: any) => void;
  className?: string;
  'data-testid'?: string;
}

interface UploadResponse {
  success: boolean;
  message: string;
  progress: {
    totalQuestions: number;
    answeredQuestions: number;
    percentage: number;
  };
  knowledgeGraphBuilt?: boolean;
  graphStats?: {
    personaCount: number;
    tableCount: number;
    columnCount: number;
    relationshipCount: number;
  };
  personasCreated?: {
    count: number;
    personas: Array<{
      id: string;
      name: string;
      description: string;
    }>;
  };
}

interface PersonaDefinition {
  name: string;
  description: string;
  keywords: string[];
}

export default function CSVUpload({ databaseId, onUploadComplete, className, 'data-testid': testId }: CSVUploadProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [buildKnowledgeGraph, setBuildKnowledgeGraph] = useState(false);
  const [selectedNeo4jConnection, setSelectedNeo4jConnection] = useState<string>("");
  const [definePersonas, setDefinePersonas] = useState(false);
  const [personas, setPersonas] = useState<PersonaDefinition[]>([]);

  // Fetch Neo4j connections for knowledge graph building option
  const { data: connections = [] } = useQuery({
    queryKey: ['/api/connections'],
    queryFn: async () => {
      const response = await fetch('/api/connections?userId=default-user');
      return response.json();
    }
  });

  const neo4jConnections = connections.filter((c: any) => c.type === 'neo4j' && c.status === 'connected');

  const uploadMutation = useMutation({
    mutationFn: async (file: File): Promise<UploadResponse> => {
      const formData = new FormData();
      formData.append('csvFile', file);
      
      // Add knowledge graph building options
      if (buildKnowledgeGraph && selectedNeo4jConnection) {
        formData.append('buildKnowledgeGraph', 'true');
        formData.append('neo4jConnectionId', selectedNeo4jConnection);
      }
      
      // Add persona definitions
      if (definePersonas && personas.length > 0) {
        formData.append('definePersonas', 'true');
        formData.append('personas', JSON.stringify(personas));
      }

      const response = await fetch(`/api/databases/${databaseId}/upload-csv`, {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || 'Upload failed');
      }

      return response.json();
    },
    onSuccess: (data) => {
      let description = data.message;
      
      // Add knowledge graph build results to the toast
      if (data.knowledgeGraphBuilt && data.graphStats) {
        description += ` Knowledge graph built with ${data.graphStats.tableCount} tables, ${data.graphStats.columnCount} columns, and ${data.graphStats.relationshipCount} relationships.`;
      } else if (buildKnowledgeGraph && !data.knowledgeGraphBuilt) {
        description += " Note: Knowledge graph building was requested but may have failed - check server logs.";
      }
      
      // Add persona creation results to the toast
      if (data.personasCreated && data.personasCreated.count > 0) {
        description += ` Created ${data.personasCreated.count} agent persona${data.personasCreated.count > 1 ? 's' : ''}: ${data.personasCreated.personas.map(p => p.name).join(', ')}.`;
      }
      
      toast({
        title: "Upload Successful",
        description,
      });
      
      setSelectedFile(null);
      setBuildKnowledgeGraph(false);
      setSelectedNeo4jConnection("");
      setDefinePersonas(false);
      setPersonas([]);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      
      // Invalidate and refetch SME questions
      queryClient.invalidateQueries({ queryKey: ['/api/databases', databaseId, 'sme-questions'] });
      queryClient.invalidateQueries({ queryKey: ['/api/databases', databaseId, 'sme-progress'] });
      
      if (onUploadComplete) {
        onUploadComplete(data.progress);
      }
    },
    onError: (error: Error) => {
      toast({
        title: "Upload Failed",
        description: error.message,
        variant: "destructive",
      });
    }
  });

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      validateAndSetFile(file);
    }
  };

  const validateAndSetFile = (file: File) => {
    // Check file type
    if (!file.name.toLowerCase().endsWith('.csv') && file.type !== 'text/csv') {
      toast({
        title: "Invalid File Type",
        description: "Please select a CSV file (.csv extension)",
        variant: "destructive",
      });
      return;
    }

    // Check file size (10MB limit)
    if (file.size > 10 * 1024 * 1024) {
      toast({
        title: "File Too Large",
        description: "File size must be less than 10MB",
        variant: "destructive",
      });
      return;
    }

    setSelectedFile(file);
  };

  const handleDragOver = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(true);
  };

  const handleDragLeave = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
  };

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);

    const file = event.dataTransfer.files?.[0];
    if (file) {
      validateAndSetFile(file);
    }
  };

  // Persona management functions
  const addNewPersona = () => {
    setPersonas([...personas, { name: '', description: '', keywords: [] }]);
  };

  const removePersona = (index: number) => {
    setPersonas(personas.filter((_, i) => i !== index));
  };

  const updatePersona = (index: number, field: keyof PersonaDefinition, value: string | string[]) => {
    const updatedPersonas = personas.map((persona, i) => 
      i === index ? { ...persona, [field]: value } : persona
    );
    setPersonas(updatedPersonas);
  };

  const updatePersonaKeywords = (index: number, keywords: string) => {
    const keywordArray = keywords.split(',').map(k => k.trim()).filter(k => k.length > 0);
    updatePersona(index, 'keywords', keywordArray);
  };

  const handleUpload = () => {
    if (!selectedFile) return;
    
    // Validate knowledge graph building options
    if (buildKnowledgeGraph && !selectedNeo4jConnection) {
      toast({
        title: "Neo4j Connection Required",
        description: "Please select a Neo4j connection to build the knowledge graph.",
        variant: "destructive",
      });
      return;
    }
    
    uploadMutation.mutate(selectedFile);
  };

  const handleClearFile = () => {
    setSelectedFile(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return (
    <Card className={className} data-testid={testId}>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Upload className="h-5 w-5" />
          Upload SME Responses
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Upload Area */}
        <div
          className={`border-2 border-dashed rounded-lg p-6 text-center transition-colors cursor-pointer ${
            dragActive
              ? 'border-primary bg-primary/5'
              : selectedFile
                ? 'border-green-300 bg-green-50 dark:bg-green-900/20'
                : 'border-gray-300 hover:border-gray-400 hover:bg-gray-50'
          }`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              fileInputRef.current?.click();
            }
          }}
          data-testid="csv-upload-dropzone"
        >
          {selectedFile ? (
            <div className="space-y-2">
              <FileText className="h-8 w-8 mx-auto text-green-600" />
              <div className="font-medium">{selectedFile.name}</div>
              <div className="text-sm text-muted-foreground">
                {formatFileSize(selectedFile.size)}
              </div>
              <div className="flex justify-center gap-2 mt-3">
                <Button
                  onClick={handleUpload}
                  disabled={uploadMutation.isPending}
                  data-testid="button-upload-csv"
                >
                  {uploadMutation.isPending ? (
                    <>
                      <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                      Uploading...
                    </>
                  ) : (
                    <>
                      <CheckCircle className="h-4 w-4 mr-2" />
                      Upload CSV
                    </>
                  )}
                </Button>
                <Button
                  variant="outline"
                  onClick={handleClearFile}
                  disabled={uploadMutation.isPending}
                  data-testid="button-clear-file"
                >
                  Clear
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <Upload className="h-8 w-8 mx-auto text-gray-400" />
              <div className="font-medium">Drop CSV file here or click to browse</div>
              <div className="text-sm text-muted-foreground">
                Maximum file size: 10MB
              </div>
            </div>
          )}
        </div>

        {/* File Input */}
        <div className="space-y-2">
          <Label htmlFor="csv-file">Select CSV File</Label>
          <Input
            ref={fileInputRef}
            id="csv-file"
            type="file"
            accept=".csv,text/csv"
            onChange={handleFileSelect}
            disabled={uploadMutation.isPending}
            data-testid="input-csv-file"
          />
        </div>

        {/* Upload Progress */}
        {uploadMutation.isPending && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Uploading...</span>
              <span className="text-sm text-muted-foreground">Processing responses</span>
            </div>
            <Progress value={100} className="animate-pulse" />
          </div>
        )}

        {/* Knowledge Graph Building Options */}
        {neo4jConnections.length > 0 && (
          <div className="space-y-4 p-4 bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg">
            <div className="flex items-center space-x-2">
              <Checkbox
                id="build-knowledge-graph"
                checked={buildKnowledgeGraph}
                onCheckedChange={(checked) => setBuildKnowledgeGraph(checked === true)}
                data-testid="checkbox-build-knowledge-graph"
              />
              <Label
                htmlFor="build-knowledge-graph"
                className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
              >
                <Network className="inline-block w-4 h-4 mr-2" />
                Build Knowledge Graph after upload
              </Label>
            </div>
            
            {buildKnowledgeGraph && (
              <div className="space-y-2">
                <Label htmlFor="neo4j-connection">Neo4j Connection</Label>
                <Select
                  value={selectedNeo4jConnection}
                  onValueChange={setSelectedNeo4jConnection}
                  data-testid="select-neo4j-connection"
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select Neo4j connection" />
                  </SelectTrigger>
                  <SelectContent>
                    {neo4jConnections.map((conn: any) => (
                      <SelectItem key={conn.id} value={conn.id}>
                        {conn.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {buildKnowledgeGraph && !selectedNeo4jConnection && (
                  <p className="text-sm text-amber-600">Please select a Neo4j connection to build the knowledge graph.</p>
                )}
              </div>
            )}
            
            <p className="text-xs text-muted-foreground">
              Automatically build an enhanced knowledge graph using SME-validated responses and relationships.
            </p>
          </div>
        )}

        {/* Persona Definition Options */}
        <div className="space-y-4 p-4 bg-purple-50 dark:bg-purple-900/20 border border-purple-200 dark:border-purple-800 rounded-lg">
          <div className="flex items-center space-x-2">
            <Checkbox
              id="define-personas"
              checked={definePersonas}
              onCheckedChange={(checked) => setDefinePersonas(checked === true)}
              data-testid="checkbox-define-personas"
            />
            <Label
              htmlFor="define-personas"
              className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            >
              <Users className="inline-block w-4 h-4 mr-2" />
              Define Agent Personas during upload
            </Label>
          </div>
          
          {definePersonas && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <Label className="text-sm font-medium">Agent Personas</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addNewPersona}
                  data-testid="button-add-persona"
                >
                  <Plus className="w-4 h-4 mr-1" />
                  Add Persona
                </Button>
              </div>
              
              {personas.map((persona, index) => (
                <div key={index} className="space-y-2 p-3 bg-white dark:bg-gray-800 border rounded-md">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-muted-foreground">
                      Persona {index + 1}
                    </Label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => removePersona(index)}
                      data-testid={`button-remove-persona-${index}`}
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                  
                  <div className="space-y-2">
                    <div>
                      <Label htmlFor={`persona-name-${index}`} className="text-xs">Name</Label>
                      <Input
                        id={`persona-name-${index}`}
                        placeholder="e.g., Database Analyst"
                        value={persona.name}
                        onChange={(e) => updatePersona(index, 'name', e.target.value)}
                        data-testid={`input-persona-name-${index}`}
                      />
                    </div>
                    
                    <div>
                      <Label htmlFor={`persona-description-${index}`} className="text-xs">Description</Label>
                      <Input
                        id={`persona-description-${index}`}
                        placeholder="Brief description of this persona's role and expertise"
                        value={persona.description}
                        onChange={(e) => updatePersona(index, 'description', e.target.value)}
                        data-testid={`input-persona-description-${index}`}
                      />
                    </div>
                    
                    <div>
                      <Label htmlFor={`persona-keywords-${index}`} className="text-xs">Keywords (comma-separated)</Label>
                      <Input
                        id={`persona-keywords-${index}`}
                        placeholder="e.g., database, analysis, relationships"
                        value={persona.keywords.join(', ')}
                        onChange={(e) => updatePersonaKeywords(index, e.target.value)}
                        data-testid={`input-persona-keywords-${index}`}
                      />
                    </div>
                  </div>
                </div>
              ))}
              
              {personas.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">
                  No personas defined. Click "Add Persona" to create agent personas for your database.
                </p>
              )}
            </div>
          )}
          
          <p className="text-xs text-muted-foreground">
            Define agent personas to represent different analytical roles and perspectives for your database.
          </p>
        </div>

        {/* Info Alert */}
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Upload a CSV file containing SME responses to update the knowledge base and optionally build knowledge graphs.
            The CSV should include answered questions with their responses.
          </AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}