interface SidebarProps {
  activeSection: string;
  onSectionChange: (section: string) => void;
  connectionStatus: {
    postgresql: string;
    gemini: string;
    neo4j: string;
  };
}

export default function Sidebar({ activeSection, onSectionChange, connectionStatus }: SidebarProps) {
  const getStatusColor = (status: string) => {
    switch (status) {
      case 'connected': return 'bg-emerald-500';
      case 'failed': return 'bg-red-500';
      default: return 'bg-amber-500';
    }
  };

  const sections = [
    {
      category: 'Pipeline',
      items: [
        { id: 'connections', label: 'Connections', icon: 'fas fa-plug' },
        { id: 'schema', label: 'Schema Discovery', icon: 'fas fa-database' },
        { id: 'sampling', label: 'Sampling Config', icon: 'fas fa-sliders-h' },
        { id: 'statistical', label: 'Statistical Analysis', icon: 'fas fa-chart-bar' },
        { id: 'ai-context', label: 'AI Context Generation', icon: 'fas fa-brain' },
        { id: 'sme-interview', label: 'SME Interview', icon: 'fas fa-question-circle' },
        { id: 'knowledge-graph', label: 'Knowledge Graph', icon: 'fas fa-project-diagram' },
      ]
    },
    {
      category: 'Export',
      items: [
        { id: 'csv-export', label: 'CSV Reports', icon: 'fas fa-file-csv' },
        { id: 'json-export', label: 'JSON Export', icon: 'fas fa-file-code' },
      ]
    }
  ];

  return (
    <aside className="w-64 bg-card border-r border-border flex flex-col">
      <nav className="flex-1 p-4 space-y-2">
        {sections.map((section) => (
          <div key={section.category} className="mb-6">
            <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-3">
              {section.category}
            </h3>
            <div className="space-y-1">
              {section.items.map((item) => (
                <button
                  key={item.id}
                  onClick={() => onSectionChange(item.id)}
                  className={`w-full flex items-center px-3 py-2 text-sm rounded-md transition-colors ${
                    activeSection === item.id
                      ? 'bg-primary/10 text-primary'
                      : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                  }`}
                  data-testid={`nav-${item.id}`}
                >
                  <i className={`${item.icon} w-4 h-4 mr-3`}></i>
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </nav>
      
      {/* System Status */}
      <div className="p-4 border-t border-border">
        <div className="bg-muted rounded-lg p-3">
          <div className="text-xs font-medium text-muted-foreground mb-2">System Status</div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs">PostgreSQL</span>
              <div 
                className={`w-2 h-2 ${getStatusColor(connectionStatus.postgresql)} rounded-full`}
                data-testid="status-postgresql"
              ></div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs">Gemini API</span>
              <div 
                className={`w-2 h-2 ${getStatusColor(connectionStatus.gemini)} rounded-full`}
                data-testid="status-gemini"
              ></div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs">Neo4j</span>
              <div 
                className={`w-2 h-2 ${getStatusColor(connectionStatus.neo4j)} rounded-full`}
                data-testid="status-neo4j"
              ></div>
            </div>
          </div>
        </div>
      </div>
    </aside>
  );
}
