import { useState, useRef } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Upload, FileText, CheckCircle, AlertCircle } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
}

export default function CSVUpload({ databaseId, onUploadComplete, className, 'data-testid': testId }: CSVUploadProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);

  const uploadMutation = useMutation({
    mutationFn: async (file: File): Promise<UploadResponse> => {
      const formData = new FormData();
      formData.append('csvFile', file);

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
      toast({
        title: "Upload Successful",
        description: data.message,
      });
      setSelectedFile(null);
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

  const handleUpload = () => {
    if (selectedFile) {
      uploadMutation.mutate(selectedFile);
    }
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

        {/* Info Alert */}
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            Upload a CSV file containing SME responses to update the knowledge base and build knowledge graphs.
            The CSV should include answered questions with their responses.
          </AlertDescription>
        </Alert>
      </CardContent>
    </Card>
  );
}