import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import CSVUpload from "@/components/CSVUpload";
import { ChevronLeft, ChevronRight } from "lucide-react";

interface SmeQuestion {
  id: string;
  tableId?: string;
  columnId?: string;
  questionType: string;
  questionText: string;
  options?: string;
  response?: string;
  isAnswered: boolean;
  priority: string;
}

interface SMEProgress {
  totalQuestions: number;
  answeredQuestions: number;
  percentage: number;
  byCategory: {
    table: { total: number; answered: number };
    column: { total: number; answered: number };
    relationship: { total: number; answered: number };
    ambiguity: { total: number; answered: number };
  };
}

export default function SMEInterview() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [responses, setResponses] = useState<Record<string, string>>({});
  const [currentPage, setCurrentPage] = useState(0);
  const questionsPerPage = 10;

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

  // Fetch SME questions
  const { data: questions = [] } = useQuery<SmeQuestion[]>({
    queryKey: ['/api/databases', database?.id, 'sme-questions'],
    queryFn: async () => {
      if (!database) return [];
      const response = await fetch(`/api/databases/${database.id}/sme-questions`);
      return response.json();
    },
    enabled: !!database
  });

  // Fetch SME progress
  const { data: progress } = useQuery<SMEProgress>({
    queryKey: ['/api/databases', database?.id, 'sme-progress'],
    queryFn: async () => {
      if (!database) return null;
      const response = await fetch(`/api/databases/${database.id}/sme-progress`);
      return response.json();
    },
    enabled: !!database
  });


  // Answer question mutation
  const answerQuestion = useMutation({
    mutationFn: async ({ questionId, response }: { questionId: string; response: string }) => {
      const res = await apiRequest('POST', `/api/sme-questions/${questionId}/answer`, { response });
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Response saved", description: "Your answer has been recorded" });
      queryClient.invalidateQueries({ queryKey: ['/api/databases', database?.id, 'sme-questions'] });
      queryClient.invalidateQueries({ queryKey: ['/api/databases', database?.id, 'sme-progress'] });
    },
    onError: (error: Error) => {
      toast({ title: "Failed to save response", description: error.message, variant: "destructive" });
    }
  });

  // FK Discovery mutation
  const discoverForeignKeys = useMutation({
    mutationFn: async () => {
      if (!database) throw new Error('No database selected');
      const res = await apiRequest('POST', `/api/databases/${database.id}/analyze-joins`, {});
      return res.json();
    },
    onSuccess: (data) => {
      const discovered = data.discoveredFks?.length || 0;
      const smeQuestions = data.smeQuestionsCount || 0;
      toast({ 
        title: "FK Discovery Complete", 
        description: `Discovered ${discovered} potential relationships. ${smeQuestions} validation questions added.` 
      });
      queryClient.invalidateQueries({ queryKey: ['/api/databases', database?.id, 'sme-questions'] });
      queryClient.invalidateQueries({ queryKey: ['/api/databases', database?.id, 'sme-progress'] });
    },
    onError: (error: Error) => {
      toast({ title: "FK Discovery failed", description: error.message, variant: "destructive" });
    }
  });

  const handleResponseChange = (questionId: string, value: string) => {
    setResponses(prev => ({ ...prev, [questionId]: value }));
  };

  const handleSubmitResponse = (questionId: string) => {
    const response = responses[questionId];
    if (!response?.trim()) {
      toast({ title: "Response required", description: "Please enter a response before submitting", variant: "destructive" });
      return;
    }
    
    answerQuestion.mutate({ questionId, response });
  };


  const exportCSV = async () => {
    if (!database) return;
    
    try {
      const response = await fetch(`/api/databases/${database.id}/export-csv`);
      if (!response.ok) {
        throw new Error('Export failed');
      }
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${database.name}-sme-questions.csv`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
      
      toast({ title: "Export successful", description: "SME questions exported to CSV" });
    } catch (error) {
      toast({ 
        title: "Export failed", 
        description: "Failed to export SME questions", 
        variant: "destructive" 
      });
    }
  };

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case 'high': return 'bg-red-100 text-red-800';
      case 'medium': return 'bg-amber-100 text-amber-800';
      case 'low': return 'bg-blue-100 text-blue-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  const getQuestionTypeIcon = (type: string) => {
    switch (type) {
      case 'table': return 'fas fa-table';
      case 'column': return 'fas fa-columns';
      case 'relationship': return 'fas fa-link';
      case 'ambiguity': return 'fas fa-question-circle';
      default: return 'fas fa-question';
    }
  };

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
        <h2 className="text-2xl font-semibold" data-testid="sme-interview-title">SME Interview & Validation</h2>
        <div className="flex space-x-2">
          <Button 
            variant="outline"
            onClick={() => discoverForeignKeys.mutate()}
            disabled={discoverForeignKeys.isPending}
            data-testid="button-discover-fks"
          >
            <i className={`fas ${discoverForeignKeys.isPending ? 'fa-spinner fa-spin' : 'fa-project-diagram'} mr-2`}></i>
            {discoverForeignKeys.isPending ? 'Discovering...' : 'Discover Relationships'}
          </Button>
          <Button 
            variant="outline"
            onClick={exportCSV}
            data-testid="button-export-csv"
          >
            <i className="fas fa-download mr-2"></i>
            Export Q&A CSV
          </Button>
        </div>
      </div>

      {/* Progress Overview */}
      {progress && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center">
              <i className="fas fa-chart-pie mr-2"></i>
              Interview Progress
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div>
                <div className="flex justify-between text-sm mb-2">
                  <span>Overall Progress</span>
                  <span className="text-primary" data-testid="overall-progress-percentage">
                    {Math.round(progress.percentage)}%
                  </span>
                </div>
                <Progress value={progress.percentage} className="h-2" data-testid="progress-overall" />
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="text-center p-3 bg-purple-50 rounded-lg">
                  <div className="text-lg font-bold text-purple-600">{progress.byCategory.table.answered}</div>
                  <div className="text-sm text-purple-800">Table Questions</div>
                  <div className="text-xs text-purple-600">of {progress.byCategory.table.total}</div>
                </div>
                <div className="text-center p-3 bg-blue-50 rounded-lg">
                  <div className="text-lg font-bold text-blue-600">{progress.byCategory.column.answered}</div>
                  <div className="text-sm text-blue-800">Column Questions</div>
                  <div className="text-xs text-blue-600">of {progress.byCategory.column.total}</div>
                </div>
                <div className="text-center p-3 bg-green-50 rounded-lg">
                  <div className="text-lg font-bold text-green-600">{progress.byCategory.relationship.answered}</div>
                  <div className="text-sm text-green-800">Relationships</div>
                  <div className="text-xs text-green-600">of {progress.byCategory.relationship.total}</div>
                </div>
                <div className="text-center p-3 bg-amber-50 rounded-lg">
                  <div className="text-lg font-bold text-amber-600">{progress.byCategory.ambiguity.answered}</div>
                  <div className="text-sm text-amber-800">Ambiguities</div>
                  <div className="text-xs text-amber-600">of {progress.byCategory.ambiguity.total}</div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Question Generation */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center">
              <i className="fas fa-brain mr-2"></i>
              Generated Questions
            </CardTitle>
            <p className="text-sm text-muted-foreground">AI-generated hypotheses requiring SME validation</p>
          </CardHeader>
          <CardContent>
            {questions.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                <p>No questions generated yet.</p>
                <p className="text-sm">Click "Generate Questions" or use "Generate Context & Questions" from AI Context Generation to create SME interview questions.</p>
              </div>
            ) : (
              <div>
                <ScrollArea className="max-h-96 mb-4">
                  <div className="space-y-4">
                    {(() => {
                      const unansweredQuestions = questions.filter(q => !q.isAnswered);
                      const startIndex = currentPage * questionsPerPage;
                      const endIndex = startIndex + questionsPerPage;
                      const paginatedQuestions = unansweredQuestions.slice(startIndex, endIndex);
                      
                      return paginatedQuestions.map((question) => (
                        <div 
                          key={question.id} 
                          className="p-4 bg-amber-50 border border-amber-200 rounded-lg"
                          data-testid={`question-${question.id}`}
                        >
                          <div className="flex items-start justify-between mb-2">
                            <div className="flex items-center">
                              <i className={`${getQuestionTypeIcon(question.questionType)} text-amber-600 mr-2`}></i>
                              <span className="font-medium text-sm text-amber-800">
                                {question.questionType.charAt(0).toUpperCase() + question.questionType.slice(1)} Question
                              </span>
                            </div>
                            <span className={`px-2 py-1 rounded text-xs ${getPriorityColor(question.priority)}`}>
                              {question.priority}
                            </span>
                          </div>
                          <p className="text-sm text-amber-700 mb-3">{question.questionText}</p>
                          {question.options && (
                            <div className="mb-3">
                              <p className="text-sm font-medium mb-1">Options:</p>
                              <div className="text-sm text-muted-foreground">
                                {(() => {
                                  try {
                                    // Try to parse as JSON array
                                    const parsedOptions = JSON.parse(question.options);
                                    if (Array.isArray(parsedOptions)) {
                                      return parsedOptions.map((option: string, index: number) => (
                                        <p key={index}>• {option}</p>
                                      ));
                                    }
                                  } catch (e) {
                                    // If JSON parsing fails, treat as plain text
                                  }
                                  // Fallback: display as plain text
                                  return <p>• {question.options}</p>;
                                })()}
                              </div>
                            </div>
                          )}
                        </div>
                      ));
                    })()}
                  </div>
                </ScrollArea>
                
                {(() => {
                  const unansweredQuestions = questions.filter(q => !q.isAnswered);
                  const totalPages = Math.ceil(unansweredQuestions.length / questionsPerPage);
                  
                  return totalPages > 1 && (
                    <div className="flex items-center justify-between">
                      <div className="text-sm text-muted-foreground">
                        Showing {Math.min(currentPage * questionsPerPage + 1, unansweredQuestions.length)} - {Math.min((currentPage + 1) * questionsPerPage, unansweredQuestions.length)} of {unansweredQuestions.length} questions
                      </div>
                      <div className="flex items-center space-x-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setCurrentPage(Math.max(0, currentPage - 1))}
                          disabled={currentPage === 0}
                          data-testid="button-previous-questions"
                        >
                          <ChevronLeft className="h-4 w-4" />
                        </Button>
                        <span className="text-sm text-muted-foreground">
                          Page {currentPage + 1} of {totalPages}
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setCurrentPage(Math.min(totalPages - 1, currentPage + 1))}
                          disabled={currentPage >= totalPages - 1}
                          data-testid="button-next-questions"
                        >
                          <ChevronRight className="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}
          </CardContent>
        </Card>
        
        {/* SME Response Interface */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center">
              <i className="fas fa-user-edit mr-2"></i>
              SME Responses
            </CardTitle>
            <p className="text-sm text-muted-foreground">Domain expert validation and context refinement</p>
          </CardHeader>
          <CardContent>
            <ScrollArea className="max-h-96">
              <div className="space-y-4">
                {/* Show answered questions */}
                {questions.filter(q => q.isAnswered).slice(0, 3).map((question) => (
                  <div 
                    key={question.id} 
                    className="p-4 bg-emerald-50 border border-emerald-200 rounded-lg"
                    data-testid={`answered-question-${question.id}`}
                  >
                    <div className="flex items-center justify-between mb-3">
                      <span className="font-medium text-sm">{question.questionType} Question</span>
                      <span className="bg-emerald-100 text-emerald-800 px-2 py-1 rounded text-xs">
                        Validated
                      </span>
                    </div>
                    <div className="space-y-2">
                      <div>
                        <p className="text-sm font-medium text-emerald-800">Question:</p>
                        <p className="text-sm text-emerald-700">{question.questionText}</p>
                      </div>
                      <div className="bg-white/50 rounded p-2">
                        <p className="text-xs font-medium">SME Response:</p>
                        <p className="text-xs text-muted-foreground">{question.response}</p>
                      </div>
                    </div>
                  </div>
                ))}

                {/* Show first unanswered question for response */}
                {(() => {
                  const unansweredQuestions = questions.filter(q => !q.isAnswered);
                  const currentQuestion = unansweredQuestions[0];
                  
                  if (!currentQuestion) {
                    return (
                      <div className="text-center py-8 text-muted-foreground">
                        {questions.length === 0 
                          ? "Generate questions to start the SME interview"
                          : "All questions have been answered!"}
                      </div>
                    );
                  }

                  return (
                    <div 
                      className="p-4 bg-gray-50 border border-gray-200 rounded-lg"
                      data-testid={`current-question-${currentQuestion.id}`}
                    >
                      <div className="flex items-center justify-between mb-3">
                        <span className="font-medium text-sm">Current Question</span>
                        <span className={`px-2 py-1 rounded text-xs ${getPriorityColor(currentQuestion.priority)}`}>
                          {currentQuestion.priority}
                        </span>
                      </div>
                      <p className="text-sm text-muted-foreground mb-3">{currentQuestion.questionText}</p>
                      <div className="space-y-2">
                        <Textarea
                          placeholder="Enter your response..."
                          value={responses[currentQuestion.id] || ''}
                          onChange={(e) => handleResponseChange(currentQuestion.id, e.target.value)}
                          rows={3}
                          className="resize-none"
                          data-testid={`textarea-response-${currentQuestion.id}`}
                        />
                        <Button
                          onClick={() => handleSubmitResponse(currentQuestion.id)}
                          disabled={answerQuestion.isPending || !responses[currentQuestion.id]?.trim()}
                          className="w-full"
                          data-testid={`button-submit-response-${currentQuestion.id}`}
                        >
                          {answerQuestion.isPending ? "Saving..." : "Submit Response"}
                        </Button>
                      </div>
                    </div>
                  );
                })()}
              </div>
            </ScrollArea>

            {/* Progress indicator at bottom */}
            {progress && (
              <div className="mt-4 pt-4 border-t border-border">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground" data-testid="questions-progress">
                    Progress: {progress.answeredQuestions} of {progress.totalQuestions} questions answered
                  </span>
                  <div className="w-32 bg-secondary rounded-full h-2">
                    <div 
                      className="bg-primary h-2 rounded-full transition-all duration-300" 
                      style={{ width: `${progress.percentage}%` }}
                    ></div>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* CSV Upload Section */}
        {database && (
          <CSVUpload 
            databaseId={database.id}
            onUploadComplete={(progress) => {
              toast({
                title: "Knowledge Base Updated",
                description: `${progress.answeredQuestions}/${progress.totalQuestions} questions now answered (${Math.round(progress.percentage)}%)`,
              });
            }}
            data-testid="csv-upload-section"
          />
        )}
      </div>
    </div>
  );
}
