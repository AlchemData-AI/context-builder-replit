export class EnvironmentService {
  private static instance: EnvironmentService;
  
  // Connection mapping based on environment
  private connectionMap = {
    development: '0c41d107-7e67-4229-a470-14936a3d4ebe',
    production: '160cbec1-6c15-4049-bd0c-0bc9d0681e85'
  };

  private constructor() {}

  static getInstance(): EnvironmentService {
    if (!EnvironmentService.instance) {
      EnvironmentService.instance = new EnvironmentService();
    }
    return EnvironmentService.instance;
  }

  /**
   * Detects current environment based on NODE_ENV and domain
   */
  getEnvironment(): 'development' | 'production' {
    // Check NODE_ENV first
    if (process.env.NODE_ENV === 'development') {
      return 'development';
    }
    
    // Check if we're running on a published replit domain
    const replitDomain = process.env.REPLIT_DOMAIN || process.env.REPL_SLUG;
    if (replitDomain && !replitDomain.includes('localhost')) {
      return 'production';
    }
    
    // Default to development for safety
    return 'development';
  }

  /**
   * Gets the appropriate Neo4j connection ID for current environment
   */
  getNeo4jConnectionId(): string {
    const env = this.getEnvironment();
    const connectionId = this.connectionMap[env];
    
    console.log(`Environment detected: ${env}, using Neo4j connection: ${connectionId}`);
    return connectionId;
  }

  /**
   * Updates connection mapping (for configuration changes)
   */
  updateConnectionMapping(env: 'development' | 'production', connectionId: string): void {
    this.connectionMap[env] = connectionId;
    console.log(`Updated ${env} Neo4j connection to: ${connectionId}`);
  }

  /**
   * Gets current connection mapping
   */
  getConnectionMapping() {
    return { ...this.connectionMap };
  }

  /**
   * Check if Neo4j shared node architecture is enabled
   * Controlled by NEO4J_USE_CANONICAL_KEYS environment variable
   */
  isNeo4jSharedNodesEnabled(): boolean {
    const enabled = process.env.NEO4J_USE_CANONICAL_KEYS === 'true';
    console.log(`Neo4j shared node architecture: ${enabled ? 'ENABLED' : 'DISABLED'} (env: NEO4J_USE_CANONICAL_KEYS=${process.env.NEO4J_USE_CANONICAL_KEYS})`);
    return enabled;
  }
}