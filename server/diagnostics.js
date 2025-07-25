/**
 * Fixed diagnostic tool for troubleshooting Pulse configuration
 */

const fs = require('fs');
const path = require('path');

class DiagnosticTool {
    constructor(stateManager, metricsHistory, apiClients, pbsApiClients) {
        this.stateManager = stateManager;
        this.metricsHistory = metricsHistory;
        this.apiClients = apiClients || {};
        this.pbsApiClients = pbsApiClients || {};
        this.errorLog = []; // Store recent errors
        this.maxErrorLogSize = 20;
    }
    
    logError(error, context = '') {
        const errorEntry = {
            timestamp: new Date().toISOString(),
            context,
            message: error.message || error.toString(),
            stack: error.stack,
            type: error.constructor.name
        };
        
        this.errorLog.unshift(errorEntry);
        if (this.errorLog.length > this.maxErrorLogSize) {
            this.errorLog = this.errorLog.slice(0, this.maxErrorLogSize);
        }
    }

    async runDiagnostics() {
        const report = {
            timestamp: new Date().toISOString(),
            version: 'unknown',
            environment: {},
            configuration: { proxmox: [], pbs: [] },
            state: {},
            permissions: { proxmox: [], pbs: [] },
            connectivity: { proxmox: [], pbs: [] },
            recentErrors: [],
            recommendations: [],
            permissionAnalysis: null // Will be populated after permission checks
        };

        try {
            report.version = this.getVersion();
        } catch (e) {
            console.error('Error getting version:', e);
        }
        
        try {
            report.environment = this.getEnvironmentInfo();
        } catch (e) {
            console.error('Error getting environment:', e);
            report.environment = { error: e.message };
        }

        try {
            report.configuration = this.getConfiguration();
        } catch (e) {
            console.error('Error getting configuration:', e);
            report.configuration = { proxmox: [], pbs: [] };
        }

        try {
            report.permissions = await this.checkPermissions();
        } catch (e) {
            console.error('Error checking permissions:', e);
            report.permissions = { proxmox: [], pbs: [] };
        }
        
        try {
            report.connectivity = await this.checkConnectivity();
        } catch (e) {
            console.error('Error checking connectivity:', e);
            report.connectivity = { proxmox: [], pbs: [] };
        }

        try {
            report.state = this.getStateInfo();
            
            // Check if we need to wait for data
            const state = this.stateManager.getState();
            const hasData = (state.vms && state.vms.length > 0) || (state.containers && state.containers.length > 0) || 
                           (state.nodes && state.nodes.length > 0);
            
            // If server has been running for more than 2 minutes, don't wait
            if (report.state.serverUptime > 120 || hasData) {
                console.log('[Diagnostics] Data already available or server has been running long enough');
                // Data should already be loaded, just use current state
            } else {
                // Only wait if server just started AND no data has loaded yet
                console.log('[Diagnostics] No data loaded yet, waiting for first discovery cycle...');
                
                const maxWaitTime = 30000; // Only wait up to 30 seconds
                const checkInterval = 500;
                const startTime = Date.now();
                
                while ((Date.now() - startTime) < maxWaitTime) {
                    const currentState = this.stateManager.getState();
                    const nowHasData = (currentState.vms && currentState.vms.length > 0) || 
                                      (currentState.containers && currentState.containers.length > 0) ||
                                      (currentState.nodes && currentState.nodes.length > 0);
                    if (nowHasData) {
                        console.log('[Diagnostics] Data loaded after', Math.floor((Date.now() - startTime) / 1000), 'seconds');
                        report.state = this.getStateInfo();
                        break;
                    }
                    await new Promise(resolve => setTimeout(resolve, checkInterval));
                }
                
                // If still no data after waiting
                const finalState = this.stateManager.getState();
                const finalHasData = (finalState.vms && finalState.vms.length > 0) || 
                                    (finalState.containers && finalState.containers.length > 0);
                if (!finalHasData) {
                    console.log('[Diagnostics] No data after waiting', Math.floor((Date.now() - startTime) / 1000), 'seconds');
                    report.state.loadTimeout = true;
                    report.state.waitTime = Math.floor((Date.now() - startTime) / 1000);
                }
            }
        } catch (e) {
            console.error('Error getting state:', e);
            report.state = { error: e.message };
        }

        // Get recent errors
        try {
            report.recentErrors = this.getRecentErrors();
        } catch (e) {
            console.error('Error getting recent errors:', e);
            report.recentErrors = [];
        }
        
        // Analyze permission mode
        try {
            this.analyzePermissionMode(report);
        } catch (e) {
            console.error('Error analyzing permissions:', e);
        }
        
        // Generate recommendations
        try {
            this.generateRecommendations(report);
        } catch (e) {
            console.error('Error generating recommendations:', e);
        }

        // Add summary for UI
        report.summary = {
            hasIssues: report.recommendations.some(r => r.severity === 'critical' || r.severity === 'warning'),
            criticalIssues: report.recommendations.filter(r => r.severity === 'critical').length,
            warnings: report.recommendations.filter(r => r.severity === 'warning').length,
            info: report.recommendations.filter(r => r.severity === 'info').length,
            isTimingIssue: report.state.loadTimeout || (report.state.serverUptime < 60 && (!report.state.guests || report.state.guests.total === 0))
        };

        // Return unsanitized report
        return report;
    }

    sanitizeReport(report) {
        // Deep clone the report to avoid modifying the original
        const sanitized = JSON.parse(JSON.stringify(report));
        
        // Environment section doesn't need sanitization except for working directory
        if (sanitized.environment && sanitized.environment.workingDirectory) {
            sanitized.environment.workingDirectory = '/opt/pulse';
        }
        
        // Sanitize connectivity section
        if (sanitized.connectivity) {
            if (sanitized.connectivity.proxmox) {
                sanitized.connectivity.proxmox = sanitized.connectivity.proxmox.map(conn => ({
                    ...conn,
                    host: this.sanitizeUrl(conn.host),
                    name: this.sanitizeUrl(conn.name),
                    error: conn.error ? this.sanitizeErrorMessage(conn.error) : null
                }));
            }
            
            if (sanitized.connectivity.pbs) {
                sanitized.connectivity.pbs = sanitized.connectivity.pbs.map(conn => ({
                    ...conn,
                    host: this.sanitizeUrl(conn.host),
                    name: this.sanitizeUrl(conn.name),
                    error: conn.error ? this.sanitizeErrorMessage(conn.error) : null
                }));
            }
        }
        
        // Recent errors are already sanitized by getRecentErrors()
        
        // Sanitize configuration section
        if (sanitized.configuration) {
            if (sanitized.configuration.proxmox) {
                sanitized.configuration.proxmox = sanitized.configuration.proxmox.map(pve => ({
                    ...pve,
                    host: this.sanitizeUrl(pve.host),
                    name: this.sanitizeUrl(pve.name),
                    // Remove potentially sensitive fields, keep only structure info
                    tokenConfigured: pve.tokenConfigured,
                    selfSignedCerts: pve.selfSignedCerts
                }));
            }
            
            if (sanitized.configuration.pbs) {
                sanitized.configuration.pbs = sanitized.configuration.pbs.map((pbs, index) => ({
                    ...pbs,
                    host: this.sanitizeUrl(pbs.host),
                    name: this.sanitizeUrl(pbs.name),
                    // Sanitize node_name
                    node_name: (pbs.node_name === 'NOT SET' || pbs.node_name === 'auto-discovered') ? pbs.node_name : `pbs-node-${index + 1}`,
                    // Remove potentially sensitive fields, keep only structure info
                    tokenConfigured: pbs.tokenConfigured,
                    selfSignedCerts: pbs.selfSignedCerts
                }));
            }
        }
        
        // Sanitize permissions section
        if (sanitized.permissions) {
            if (sanitized.permissions.proxmox) {
                sanitized.permissions.proxmox = sanitized.permissions.proxmox.map((perm, permIndex) => ({
                    ...perm,
                    host: this.sanitizeUrl(perm.host),
                    name: this.sanitizeUrl(perm.name),
                    // Sanitize storage details if present
                    storageBackupAccess: perm.storageBackupAccess ? {
                        ...perm.storageBackupAccess,
                        storageDetails: perm.storageBackupAccess.storageDetails ? 
                            perm.storageBackupAccess.storageDetails.map((storage, idx) => ({
                                node: `node-${idx + 1}`,
                                storage: `storage-${permIndex + 1}-${idx + 1}`,
                                type: storage.type,
                                accessible: storage.accessible,
                                backupCount: storage.backupCount
                            })) : []
                    } : perm.storageBackupAccess,
                    // Keep diagnostic info but sanitize error messages
                    errors: perm.errors ? perm.errors.map(err => this.sanitizeErrorMessage(err)) : []
                }));
            }
            
            if (sanitized.permissions.pbs) {
                sanitized.permissions.pbs = sanitized.permissions.pbs.map((perm, index) => ({
                    ...perm,
                    host: this.sanitizeUrl(perm.host),
                    name: this.sanitizeUrl(perm.name),
                    // Sanitize node_name
                    node_name: (perm.node_name === 'NOT SET' || perm.node_name === 'auto-discovered') ? perm.node_name : `pbs-node-${index + 1}`,
                    // Keep namespace test results
                    canListNamespaces: perm.canListNamespaces,
                    discoveredNamespaces: perm.discoveredNamespaces ? perm.discoveredNamespaces.length : 0,
                    // Sanitize namespace names but keep structure
                    namespaceAccess: perm.namespaceAccess ? Object.keys(perm.namespaceAccess).reduce((acc, ns, nsIdx) => {
                        const sanitizedNs = ns === 'root' ? 'root' : `namespace-${nsIdx}`;
                        acc[sanitizedNs] = {
                            ...perm.namespaceAccess[ns],
                            namespace: sanitizedNs
                        };
                        return acc;
                    }, {}) : {},
                    // Keep diagnostic info but sanitize error messages
                    errors: perm.errors ? perm.errors.map(err => this.sanitizeErrorMessage(err)) : []
                }));
            }
        }
        
        // Sanitize state section
        if (sanitized.state) {
            // Remove potentially sensitive node names, keep only counts and structure
            if (sanitized.state.nodes && sanitized.state.nodes.names) {
                sanitized.state.nodes.names = sanitized.state.nodes.names.map((name, index) => `node-${index + 1}`);
            }
            
            // Remove specific backup IDs, keep only counts
            if (sanitized.state.pbs && sanitized.state.pbs.sampleBackupIds) {
                sanitized.state.pbs.sampleBackupIds = sanitized.state.pbs.sampleBackupIds.map((id, index) => `backup-${index + 1}`);
            }
            
            // Sanitize storage debug information
            if (sanitized.state.storageDebug && sanitized.state.storageDebug.storageByNode) {
                sanitized.state.storageDebug.storageByNode = sanitized.state.storageDebug.storageByNode.map((nodeInfo, nodeIndex) => ({
                    node: `node-${nodeIndex + 1}`,
                    endpointId: nodeInfo.endpointId === 'primary' ? 'primary' : 'secondary',
                    storageCount: nodeInfo.storageCount,
                    storages: nodeInfo.storages.map((storage, storageIndex) => ({
                        name: `storage-${nodeIndex + 1}-${storageIndex + 1}`,
                        type: storage.type,
                        content: storage.content,
                        shared: storage.shared,
                        enabled: storage.enabled,
                        hasBackupContent: storage.hasBackupContent
                    }))
                }));
            }
        }
        
        // Sanitize PBS namespace info if present
        if (sanitized.state && sanitized.state.pbs && sanitized.state.pbs.namespaceInfo) {
            const sanitizedNamespaceInfo = {};
            Object.keys(sanitized.state.pbs.namespaceInfo).forEach((ns, idx) => {
                const sanitizedNs = ns === 'root' ? 'root' : `namespace-${idx}`;
                sanitizedNamespaceInfo[sanitizedNs] = {
                    ...sanitized.state.pbs.namespaceInfo[ns],
                    instances: sanitized.state.pbs.namespaceInfo[ns].instances || []
                };
            });
            sanitized.state.pbs.namespaceInfo = sanitizedNamespaceInfo;
        }
        
        // Sanitize namespace filtering debug info if present
        if (sanitized.state && sanitized.state.namespaceFilteringDebug) {
            if (sanitized.state.namespaceFilteringDebug.sharedNamespaces) {
                sanitized.state.namespaceFilteringDebug.sharedNamespaces = 
                    sanitized.state.namespaceFilteringDebug.sharedNamespaces.map((ns, idx) => ({
                        namespace: ns.namespace === 'root' ? 'root' : `namespace-${idx}`,
                        instances: ns.instances || [],
                        totalBackups: ns.totalBackups,
                        perInstanceCounts: ns.perInstanceCounts || {}
                    }));
            }
            if (sanitized.state.namespaceFilteringDebug.currentFilters) {
                const filters = sanitized.state.namespaceFilteringDebug.currentFilters;
                if (filters.namespace && filters.namespace !== 'all' && filters.namespace !== 'root') {
                    filters.namespace = 'namespace-filtered';
                }
            }
        }
        
        // Sanitize recommendations
        if (sanitized.recommendations) {
            sanitized.recommendations = sanitized.recommendations.map(rec => ({
                ...rec,
                message: this.sanitizeRecommendationMessage(rec.message)
            }));
        }
        
        // Add notice about sanitization
        sanitized._sanitized = {
            notice: "This diagnostic report has been sanitized for safe sharing. Hostnames, IPs, node names, and backup IDs have been anonymized while preserving structural information needed for troubleshooting.",
            timestamp: new Date().toISOString()
        };
        
        return sanitized;
    }
    
    sanitizeErrorMessage(errorMsg) {
        if (!errorMsg) return errorMsg;
        
        // Remove potential IP addresses, hostnames, and ports
        let sanitized = errorMsg
            .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '[IP-ADDRESS]')
            .replace(/https?:\/\/[^\/\s:]+(?::\d+)?/g, '[HOSTNAME]')
            .replace(/([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}/g, '[HOSTNAME]')
            .replace(/:\d{4,5}\b/g, ':[PORT]');
            
        return sanitized;
    }
    
    sanitizeRecommendationMessage(message) {
        if (!message) return message;
        
        // Remove potential hostnames and IPs from recommendation messages
        let sanitized = message
            .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '[IP-ADDRESS]')
            .replace(/https?:\/\/[^\/\s:]+(?::\d+)?/g, '[HOSTNAME]')
            .replace(/([a-zA-Z0-9-]+\.)+[a-zA-Z]{2,}/g, '[HOSTNAME]')
            .replace(/"[^"]*\.lan[^"]*"/g, '"[HOSTNAME]"')
            .replace(/"[^"]*\.local[^"]*"/g, '"[HOSTNAME]"')
            .replace(/namespaces?: ([a-zA-Z0-9-_]+(?:, [a-zA-Z0-9-_]+)*)/g, (match, namespaces) => {
                const nsList = namespaces.split(', ');
                const sanitizedList = nsList.map(ns => ns === 'root' ? 'root' : '[namespace]');
                return match.replace(namespaces, sanitizedList.join(', '));
            });
            
        return sanitized;
    }

    getVersion() {
        try {
            const packagePath = path.join(__dirname, '..', 'package.json');
            const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
            return packageJson.version || 'unknown';
        } catch (error) {
            return 'unknown';
        }
    }
    
    getEnvironmentInfo() {
        const os = require('os');
        
        const totalMemoryMB = Math.round(os.totalmem() / 1024 / 1024);
        const freeMemoryMB = Math.round(os.freemem() / 1024 / 1024);
        const usedMemoryMB = totalMemoryMB - freeMemoryMB;
        
        const env = {
            nodeVersion: process.version,
            platform: process.platform,
            arch: process.arch,
            osRelease: os.release(),
            osType: os.type(),
            totalMemory: totalMemoryMB + ' MB',
            freeMemory: freeMemoryMB + ' MB',
            usedMemory: usedMemoryMB + ' MB',
            cpuCount: os.cpus().length,
            uptime: Math.round(process.uptime()) + ' seconds',
            dockerDetected: fs.existsSync('/.dockerenv') || process.env.container === 'docker',
            environmentVariables: this.getSanitizedEnvVars(),
            workingDirectory: process.cwd(),
            nodeMemoryUsage: {
                rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + ' MB',
                heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + ' MB',
                heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB',
                external: Math.round(process.memoryUsage().external / 1024 / 1024) + ' MB'
            }
        };
        
        // Check if running as specific user
        try {
            env.runningUser = process.getuid ? `uid:${process.getuid()}` : 'unknown';
        } catch (e) {
            env.runningUser = 'unknown';
        }
        
        return env;
    }
    
    getSanitizedEnvVars() {
        const sensitiveKeys = ['TOKEN', 'SECRET', 'PASSWORD', 'KEY', 'API', 'CREDENTIAL'];
        const envVars = {};
        
        Object.keys(process.env).forEach(key => {
            if (key.startsWith('PVE_') || key.startsWith('PBS_') || key.startsWith('PULSE_') || 
                key.startsWith('ALERT_') || key === 'NODE_ENV' || key === 'PORT') {
                
                // Check if it's a sensitive key
                const isSensitive = sensitiveKeys.some(sensitive => key.includes(sensitive));
                
                if (isSensitive) {
                    envVars[key] = process.env[key] ? '[REDACTED]' : '[NOT SET]';
                } else {
                    envVars[key] = process.env[key] || '[NOT SET]';
                }
            }
        });
        
        return envVars;
    }
    
    getRecentErrors() {
        // Return sanitized version of error log
        return this.errorLog.map(error => ({
            timestamp: error.timestamp,
            context: error.context,
            message: this.sanitizeErrorMessage(error.message),
            type: error.type,
            // Include stack trace but sanitize it
            stack: error.stack ? this.sanitizeErrorMessage(error.stack) : undefined
        }));
    }

    async checkConnectivity() {
        const connectivity = {
            proxmox: [],
            pbs: []
        };
        
        // Test Proxmox connectivity
        for (const [id, clientObj] of Object.entries(this.apiClients)) {
            if (!id.startsWith('pbs_') && clientObj && clientObj.client) {
                const connTest = {
                    id: id,
                    name: clientObj.config?.name || id,
                    host: clientObj.config?.host,
                    reachable: false,
                    responseTime: null,
                    error: null,
                    sslInfo: {}
                };
                
                const startTime = Date.now();
                try {
                    // Simple connectivity test
                    const response = await clientObj.client.get('/version');
                    connTest.reachable = true;
                    connTest.responseTime = Date.now() - startTime;
                    
                    // Check if using self-signed certs
                    connTest.sslInfo.selfSigned = clientObj.config?.allowSelfSignedCerts || false;
                } catch (error) {
                    connTest.error = error.message;
                    connTest.responseTime = Date.now() - startTime;
                    
                    // Try to categorize the error
                    if (error.code === 'ECONNREFUSED') {
                        connTest.errorType = 'connection_refused';
                    } else if (error.code === 'ETIMEDOUT') {
                        connTest.errorType = 'timeout';
                    } else if (error.code === 'ENOTFOUND') {
                        connTest.errorType = 'dns_failure';
                    } else if (error.message.includes('certificate')) {
                        connTest.errorType = 'ssl_error';
                    } else {
                        connTest.errorType = 'unknown';
                    }
                }
                
                connectivity.proxmox.push(connTest);
            }
        }
        
        // Test PBS connectivity
        for (const [id, clientObj] of Object.entries(this.pbsApiClients)) {
            if (clientObj && clientObj.client) {
                const connTest = {
                    id: id,
                    name: clientObj.config?.name || id,
                    host: clientObj.config?.host,
                    reachable: false,
                    responseTime: null,
                    error: null,
                    sslInfo: {}
                };
                
                const startTime = Date.now();
                try {
                    // Simple connectivity test
                    const response = await clientObj.client.get('/version');
                    connTest.reachable = true;
                    connTest.responseTime = Date.now() - startTime;
                    
                    // Check if using self-signed certs
                    connTest.sslInfo.selfSigned = clientObj.config?.allowSelfSignedCerts || false;
                } catch (error) {
                    connTest.error = error.message;
                    connTest.responseTime = Date.now() - startTime;
                    
                    // Try to categorize the error
                    if (error.code === 'ECONNREFUSED') {
                        connTest.errorType = 'connection_refused';
                    } else if (error.code === 'ETIMEDOUT') {
                        connTest.errorType = 'timeout';
                    } else if (error.code === 'ENOTFOUND') {
                        connTest.errorType = 'dns_failure';
                    } else if (error.message.includes('certificate')) {
                        connTest.errorType = 'ssl_error';
                    } else {
                        connTest.errorType = 'unknown';
                    }
                }
                
                connectivity.pbs.push(connTest);
            }
        }
        
        return connectivity;
    }
    
    async checkPermissions() {
        const permissions = {
            proxmox: [],
            pbs: []
        };

        // Check Proxmox permissions
        for (const [id, clientObj] of Object.entries(this.apiClients)) {
            if (!id.startsWith('pbs_') && clientObj && clientObj.client) {
                const permCheck = {
                    id: id,
                    name: clientObj.config?.name || id,
                    host: clientObj.config?.host,
                    tokenId: clientObj.config?.tokenId,
                    canConnect: false,
                    canListNodes: false,
                    canListVMs: false,
                    canListContainers: false,
                    canGetNodeStats: false,
                    canListStorage: false,
                    canAccessStorageBackups: false,
                    storageBackupAccess: {
                        totalStoragesTested: 0,
                        accessibleStorages: 0,
                        storageDetails: []
                    },
                    errors: []
                };

                try {
                    // Test basic connection and version endpoint
                    const versionData = await clientObj.client.get('/version');
                    if (versionData && versionData.data) {
                        permCheck.canConnect = true;
                        permCheck.version = versionData.data.version;
                    }
                } catch (error) {
                    permCheck.errors.push(`Connection failed: ${error.message}`);
                }

                if (permCheck.canConnect) {
                    // Test node listing permission
                    try {
                        const nodesData = await clientObj.client.get('/nodes');
                        if (nodesData && nodesData.data && Array.isArray(nodesData.data.data)) {
                            permCheck.canListNodes = true;
                            permCheck.nodeCount = nodesData.data.data.length;
                        }
                    } catch (error) {
                        permCheck.errors.push(`Cannot list nodes: ${error.message}`);
                    }

                    // Test VM listing permission using the same method as the actual app
                    if (permCheck.canListNodes && permCheck.nodeCount > 0) {
                        try {
                            const nodesData = await clientObj.client.get('/nodes');
                            let totalVMs = 0;
                            let vmCheckSuccessful = false;
                            
                            for (const node of nodesData.data.data) {
                                if (node && node.node) {
                                    try {
                                        const vmData = await clientObj.client.get(`/nodes/${node.node}/qemu`);
                                        if (vmData && vmData.data) {
                                            vmCheckSuccessful = true;
                                            totalVMs += vmData.data.data ? vmData.data.data.length : 0;
                                        }
                                    } catch (nodeError) {
                                        permCheck.errors.push(`Cannot list VMs on node ${node.node}: ${nodeError.message}`);
                                    }
                                }
                            }
                            
                            if (vmCheckSuccessful) {
                                permCheck.canListVMs = true;
                                permCheck.vmCount = totalVMs;
                            }
                        } catch (error) {
                            permCheck.errors.push(`Cannot list VMs: ${error.message}`);
                        }
                    } else {
                        permCheck.errors.push('Cannot test VM listing: No nodes available');
                    }

                    // Test Container listing permission using the same method as the actual app
                    if (permCheck.canListNodes && permCheck.nodeCount > 0) {
                        try {
                            const nodesData = await clientObj.client.get('/nodes');
                            let totalContainers = 0;
                            let containerCheckSuccessful = false;
                            
                            for (const node of nodesData.data.data) {
                                if (node && node.node) {
                                    try {
                                        const lxcData = await clientObj.client.get(`/nodes/${node.node}/lxc`);
                                        if (lxcData && lxcData.data) {
                                            containerCheckSuccessful = true;
                                            totalContainers += lxcData.data.data ? lxcData.data.data.length : 0;
                                        }
                                    } catch (nodeError) {
                                        permCheck.errors.push(`Cannot list containers on node ${node.node}: ${nodeError.message}`);
                                    }
                                }
                            }
                            
                            if (containerCheckSuccessful) {
                                permCheck.canListContainers = true;
                                permCheck.containerCount = totalContainers;
                            }
                        } catch (error) {
                            permCheck.errors.push(`Cannot list containers: ${error.message}`);
                        }
                    } else {
                        permCheck.errors.push('Cannot test container listing: No nodes available');
                    }

                    if (permCheck.canListNodes && permCheck.nodeCount > 0) {
                        try {
                            const nodesData = await clientObj.client.get('/nodes');
                            const firstNode = nodesData.data.data[0];
                            if (firstNode && firstNode.node) {
                                const statsData = await clientObj.client.get(`/nodes/${firstNode.node}/status`);
                                if (statsData && statsData.data) {
                                    permCheck.canGetNodeStats = true;
                                }
                            }
                        } catch (error) {
                            permCheck.errors.push(`Cannot get node stats: ${error.message}`);
                        }
                    }

                    if (permCheck.canListNodes && permCheck.nodeCount > 0) {
                        try {
                            const nodesData = await clientObj.client.get('/nodes');
                            
                            // Test storage listing on each node
                            let storageTestSuccessful = false;
                            let totalStoragesTested = 0;
                            let accessibleStorages = 0;
                            const storageDetails = [];
                            
                            for (const node of nodesData.data.data) {
                                if (node && node.node) {
                                    try {
                                        // Test storage listing endpoint
                                        const storageData = await clientObj.client.get(`/nodes/${node.node}/storage`);
                                        if (storageData && storageData.data && Array.isArray(storageData.data.data)) {
                                            storageTestSuccessful = true;
                                            
                                            // Test backup content access on each storage that supports backups
                                            for (const storage of storageData.data.data) {
                                                if (storage && storage.storage && storage.content && 
                                                    storage.content.includes('backup') && storage.type !== 'pbs') {
                                                    totalStoragesTested++;
                                                    
                                                    try {
                                                        // This is the critical test - accessing backup content requires PVEDatastoreAdmin
                                                        const backupData = await clientObj.client.get(
                                                            `/nodes/${node.node}/storage/${storage.storage}/content`,
                                                            { params: { content: 'backup' } }
                                                        );
                                                        
                                                        if (backupData && backupData.data) {
                                                            const backupCount = backupData.data.data ? backupData.data.data.length : 0;
                                                            // Only count as accessible if we can actually see backups
                                                            // API success with 0 backups means Datastore.Audit only
                                                            if (backupCount > 0) {
                                                                accessibleStorages++;
                                                            }
                                                            storageDetails.push({
                                                                node: node.node,
                                                                storage: storage.storage,
                                                                type: storage.type,
                                                                accessible: backupCount > 0,
                                                                backupCount: backupCount
                                                            });
                                                        }
                                                    } catch (storageError) {
                                                        // 403 errors are common here - this is what we want to detect
                                                        const is403 = storageError.response?.status === 403;
                                                        storageDetails.push({
                                                            node: node.node,
                                                            storage: storage.storage,
                                                            type: storage.type,
                                                            accessible: false,
                                                            error: is403 ? 'Permission denied (403) - needs Datastore.Allocate permission' : storageError.message
                                                        });
                                                        
                                                        if (is403) {
                                                            permCheck.errors.push(`Storage ${storage.storage} on ${node.node}: Permission denied accessing backup content. The Proxmox API requires 'Datastore.Allocate' permission to list storage contents.`);
                                                        } else {
                                                            permCheck.errors.push(`Storage ${storage.storage} on ${node.node}: ${storageError.message}`);
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    } catch (nodeStorageError) {
                                        permCheck.errors.push(`Cannot list storage on node ${node.node}: ${nodeStorageError.message}`);
                                    }
                                }
                            }
                            
                            if (storageTestSuccessful) {
                                permCheck.canListStorage = true;
                            }
                            
                            permCheck.storageBackupAccess = {
                                totalStoragesTested,
                                accessibleStorages,
                                storageDetails: storageDetails.slice(0, 10) // Limit details for report size
                            };
                            
                            // Set overall storage backup access status
                            // Only true if we can actually see backup files, not just call the API
                            permCheck.canAccessStorageBackups = totalStoragesTested > 0 && accessibleStorages > 0;
                            
                        } catch (error) {
                            permCheck.errors.push(`Cannot test storage permissions: ${error.message}`);
                        }
                    }
                }

                permissions.proxmox.push(permCheck);
            }
        }

        // Check PBS permissions
        for (const [id, clientObj] of Object.entries(this.pbsApiClients)) {
            if (clientObj && clientObj.client) {
                const permCheck = {
                    id: id,
                    name: clientObj.config?.name || id,
                    host: clientObj.config?.host,
                    tokenId: clientObj.config?.tokenId,
                    node_name: clientObj.config?.nodeName || clientObj.config?.node_name || 'auto-discovered',
                    canConnect: false,
                    canListDatastores: false,
                    canListBackups: false,
                    canListNamespaces: false,
                    namespaceAccess: {},
                    errors: []
                };

                try {
                    // Test basic connection using the correct PBS API endpoint
                    const versionData = await clientObj.client.get('/version');
                    if (versionData && versionData.data) {
                        permCheck.canConnect = true;
                        permCheck.version = versionData.data.data?.version || versionData.data.version;
                    }
                } catch (error) {
                    permCheck.errors.push(`Connection failed: ${error.message}`);
                }

                if (permCheck.canConnect) {
                    // Test datastore listing permission using the primary endpoint the app uses
                    try {
                        const datastoreData = await clientObj.client.get('/status/datastore-usage');
                        if (datastoreData && datastoreData.data && Array.isArray(datastoreData.data.data)) {
                            permCheck.canListDatastores = true;
                            permCheck.datastoreCount = datastoreData.data.data.length;
                            
                            // Test backup listing and namespace access on first datastore
                            const firstDatastore = datastoreData.data.data[0];
                            if (firstDatastore && firstDatastore.store) {
                                // Test namespace listing capability
                                try {
                                    const namespaceResponse = await clientObj.client.get(`/admin/datastore/${firstDatastore.store}/namespace`);
                                    if (namespaceResponse && namespaceResponse.data) {
                                        permCheck.canListNamespaces = true;
                                        const namespaces = namespaceResponse.data.data || [];
                                        permCheck.discoveredNamespaces = namespaces.map(ns => ns.ns || ns.path || ns.name).filter(ns => ns !== undefined);
                                    }
                                } catch (nsError) {
                                    if (nsError.response?.status !== 404) {
                                        permCheck.errors.push(`Cannot list namespaces in datastore ${firstDatastore.store}: ${nsError.message}`);
                                    }
                                    // 404 is expected on older PBS versions without namespace support
                                }
                                
                                // Test backup listing in root namespace
                                try {
                                    const groupsParams = {};
                                    const namespacesToTest = [];
                                    
                                    // Always test root namespace
                                    namespacesToTest.push({ ns: '', label: 'root' });
                                    
                                    for (const nsTest of namespacesToTest) {
                                        try {
                                            const testParams = { ...groupsParams };
                                            if (nsTest.ns) {
                                                testParams.ns = nsTest.ns;
                                            }
                                            
                                            const backupData = await clientObj.client.get(`/admin/datastore/${firstDatastore.store}/groups`, {
                                                params: testParams
                                            });
                                            
                                            if (backupData && backupData.data) {
                                                permCheck.canListBackups = true;
                                                permCheck.namespaceAccess[nsTest.label] = {
                                                    namespace: nsTest.ns || 'root',
                                                    accessible: true,
                                                    backupCount: backupData.data.data ? backupData.data.data.length : 0
                                                };
                                            }
                                        } catch (nsBackupError) {
                                            permCheck.namespaceAccess[nsTest.label] = {
                                                namespace: nsTest.ns || 'root',
                                                accessible: false,
                                                error: nsBackupError.message
                                            };
                                        }
                                    }
                                    
                                    // Calculate total backup count from accessible namespaces
                                    permCheck.backupCount = Object.values(permCheck.namespaceAccess)
                                        .filter(ns => ns.accessible)
                                        .reduce((sum, ns) => sum + (ns.backupCount || 0), 0);
                                        
                                } catch (error) {
                                    permCheck.errors.push(`Cannot list backup groups in datastore ${firstDatastore.store}: ${error.message}`);
                                }
                            }
                        }
                    } catch (error) {
                        // Try fallback endpoint
                        try {
                            const configData = await clientObj.client.get('/config/datastore');
                            if (configData && configData.data && Array.isArray(configData.data.data)) {
                                permCheck.canListDatastores = true;
                                permCheck.datastoreCount = configData.data.data.length;
                            }
                        } catch (fallbackError) {
                            permCheck.errors.push(`Cannot list datastores: ${error.message}`);
                        }
                    }
                }

                permissions.pbs.push(permCheck);
            }
        }

        return permissions;
    }

    getConfiguration() {
        const config = {
            proxmox: [],
            pbs: [],
            alerts: {
                cpu: {
                    enabled: process.env.ALERT_CPU_ENABLED !== 'false',
                    threshold: process.env.ALERT_CPU_THRESHOLD || '85'
                },
                memory: {
                    enabled: process.env.ALERT_MEMORY_ENABLED !== 'false',
                    threshold: process.env.ALERT_MEMORY_THRESHOLD || '90'
                },
                disk: {
                    enabled: process.env.ALERT_DISK_ENABLED !== 'false',
                    threshold: process.env.ALERT_DISK_THRESHOLD || '95'
                }
            }
        };

        // Get Proxmox configurations
        try {
            Object.entries(this.apiClients).forEach(([id, clientObj]) => {
                if (!id.startsWith('pbs_') && clientObj && clientObj.config) {
                    config.proxmox.push({
                        id: id,
                        host: clientObj.config.host,
                        name: clientObj.config.name || id,
                        port: clientObj.config.port || '8006',
                        tokenConfigured: !!clientObj.config.tokenId,
                        selfSignedCerts: clientObj.config.allowSelfSignedCerts || false
                    });
                }
            });
        } catch (e) {
            console.error('Error getting Proxmox config:', e);
        }

        // Get PBS configurations
        try {
            Object.entries(this.pbsApiClients).forEach(([id, clientObj]) => {
                if (clientObj && clientObj.config) {
                    const nodeName = clientObj.config.nodeName || clientObj.config.node_name;
                    config.pbs.push({
                        id: id,
                        host: clientObj.config.host,
                        name: clientObj.config.name || id,
                        port: clientObj.config.port || '8007',
                        node_name: nodeName || 'auto-discovered',
                        tokenConfigured: !!clientObj.config.tokenId,
                        selfSignedCerts: clientObj.config.allowSelfSignedCerts || false
                    });
                }
            });
        } catch (e) {
            console.error('Error getting PBS config:', e);
        }

        return config;
    }

    getStateInfo() {
        try {
            const state = this.stateManager.getState();
            const stats = this.stateManager.getPerformanceStats ? this.stateManager.getPerformanceStats() : {};
            
            // Find the actual last update time
            const lastUpdateTime = state.lastUpdate || state.stats?.lastUpdated || null;
            
            const info = {
                lastUpdate: lastUpdateTime,
                serverUptime: process.uptime(),
                dataAge: lastUpdateTime ? Math.floor((Date.now() - new Date(lastUpdateTime).getTime()) / 1000) : null,
                nodes: {
                    count: state.nodes?.length || 0,
                    names: state.nodes?.map(n => n.node || n.name).slice(0, 5) || []
                },
                guests: {
                    total: (state.vms?.length || 0) + (state.containers?.length || 0),
                    vms: state.vms?.length || 0,
                    containers: state.containers?.length || 0,
                    running: ((state.vms?.filter(v => v.status === 'running') || []).length + 
                             (state.containers?.filter(c => c.status === 'running') || []).length),
                    stopped: ((state.vms?.filter(v => v.status === 'stopped') || []).length + 
                             (state.containers?.filter(c => c.status === 'stopped') || []).length)
                },
                pbs: {
                    instances: state.pbs?.length || 0,
                    totalBackups: 0,
                    datastores: 0,
                    sampleBackupIds: [],
                    instanceDetails: [], // Add array to store individual PBS instance details
                    namespaceInfo: {} // Track namespace usage
                },
                pveBackups: {
                    backupTasks: state.pveBackups?.backupTasks?.length || 0,
                    storageBackups: state.pveBackups?.storageBackups?.length || 0,
                    guestSnapshots: state.pveBackups?.guestSnapshots?.length || 0
                },
                performance: {
                    lastDiscoveryTime: stats.lastDiscoveryCycleTime || 'N/A',
                    lastMetricsTime: stats.lastMetricsCycleTime || 'N/A'
                },
                alerts: {
                    active: this.stateManager.alertManager?.getActiveAlerts ? 
                        this.stateManager.alertManager.getActiveAlerts().length : 0
                }
            };

            // Add storage diagnostics
            if (state.nodes && Array.isArray(state.nodes)) {
                info.storageDebug = {
                    nodeCount: state.nodes.length,
                    storageByNode: []
                };
                
                state.nodes.forEach(node => {
                    const nodeStorage = {
                        node: node.node,
                        endpointId: node.endpointId,
                        storageCount: node.storage?.length || 0,
                        storages: []
                    };
                    
                    if (node.storage && Array.isArray(node.storage)) {
                        nodeStorage.storages = node.storage.map(s => ({
                            name: s.storage,
                            type: s.type,
                            content: s.content,
                            shared: s.shared,
                            enabled: s.enabled,
                            hasBackupContent: s.content?.includes('backup') || false
                        }));
                    }
                    
                    info.storageDebug.storageByNode.push(nodeStorage);
                });
            }
            
            // Add namespace filtering diagnostics
            if (state.pbs && Array.isArray(state.pbs) && state.pbs.length > 1) {
                info.namespaceFilteringDebug = {
                    multiplePbsInstances: true,
                    pbsInstanceCount: state.pbs.length,
                    sharedNamespaces: [],
                    currentFilters: {
                        namespace: state.backupsFilterNamespace || 'all',
                        pbsInstance: state.backupsFilterPbsInstance || 'all'
                    }
                };
                
                // Find namespaces that exist on multiple PBS instances
                Object.entries(info.pbs.namespaceInfo || {}).forEach(([namespace, nsInfo]) => {
                    if (nsInfo.instances && nsInfo.instances.length > 1) {
                        info.namespaceFilteringDebug.sharedNamespaces.push({
                            namespace: namespace,
                            instances: nsInfo.instances,
                            totalBackups: nsInfo.backupCount,
                            perInstanceCounts: nsInfo.instanceBackupCounts || {}
                        });
                    }
                });
            }
            
            // Count PBS backups and get samples
            if (state.pbs && Array.isArray(state.pbs)) {
                state.pbs.forEach((pbsInstance, idx) => {
                    // Store instance details for matching in recommendations
                    const instanceDetail = {
                        name: pbsInstance.pbsInstanceName || `pbs-${idx}`,
                        index: idx,
                        datastores: 0,
                        snapshots: 0,
                        namespaces: new Set(),
                        namespaceBackupCounts: {} // Track backup count per namespace
                    };
                    
                    if (pbsInstance.datastores) {
                        info.pbs.datastores += pbsInstance.datastores.length;
                        instanceDetail.datastores = pbsInstance.datastores.length;
                        
                        pbsInstance.datastores.forEach(ds => {
                            if (ds.snapshots) {
                                info.pbs.totalBackups += ds.snapshots.length;
                                instanceDetail.snapshots += ds.snapshots.length;
                                // Get unique backup IDs and track namespaces
                                ds.snapshots.forEach(snap => {
                                    const backupId = snap['backup-id'];
                                    if (backupId && !info.pbs.sampleBackupIds.includes(backupId)) {
                                        info.pbs.sampleBackupIds.push(backupId);
                                    }
                                    
                                    // Track namespace usage
                                    if (snap.ns !== undefined) {
                                        const namespace = snap.ns || 'root';
                                        instanceDetail.namespaces.add(namespace);
                                        
                                        // Track backup count per namespace for this instance
                                        if (!instanceDetail.namespaceBackupCounts[namespace]) {
                                            instanceDetail.namespaceBackupCounts[namespace] = 0;
                                        }
                                        instanceDetail.namespaceBackupCounts[namespace]++;
                                        
                                        // Track global namespace info
                                        if (!info.pbs.namespaceInfo[namespace]) {
                                            info.pbs.namespaceInfo[namespace] = {
                                                backupCount: 0,
                                                instances: new Set(),
                                                instanceBackupCounts: {} // Track per-instance counts
                                            };
                                        }
                                        info.pbs.namespaceInfo[namespace].backupCount++;
                                        info.pbs.namespaceInfo[namespace].instances.add(instanceDetail.name);
                                        info.pbs.namespaceInfo[namespace].instanceBackupCounts[instanceDetail.name] = 
                                            (info.pbs.namespaceInfo[namespace].instanceBackupCounts[instanceDetail.name] || 0) + 1;
                                    }
                                });
                            }
                        });
                    }
                    
                    // Convert Set to Array for JSON serialization
                    instanceDetail.namespaces = Array.from(instanceDetail.namespaces);
                    info.pbs.instanceDetails.push(instanceDetail);
                });
                
                // Convert namespace info Sets to Arrays for JSON serialization
                Object.keys(info.pbs.namespaceInfo).forEach(ns => {
                    info.pbs.namespaceInfo[ns].instances = Array.from(info.pbs.namespaceInfo[ns].instances);
                });
                
                // Limit sample backup IDs
                info.pbs.sampleBackupIds = info.pbs.sampleBackupIds.slice(0, 10);
            }

            return info;
        } catch (e) {
            console.error('Error getting state info:', e);
            return {
                error: e.message,
                lastUpdate: 'unknown',
                nodes: { count: 0 },
                guests: { total: 0 },
                pbs: { instances: 0 }
            };
        }
    }

    analyzePermissionMode(report) {
        // Initialize permission analysis
        report.permissionAnalysis = {
            mode: 'unknown',
            hasStorageAccess: false,
            pveInstances: [],
            pbsInstances: [],
            details: {
                canMonitorCore: false,
                canViewPveBackups: false,
                canViewPbsBackups: false,
                canViewSnapshots: false
            }
        };
        
        // Analyze PVE permissions
        if (report.permissions && report.permissions.proxmox && Array.isArray(report.permissions.proxmox)) {
            report.permissions.proxmox.forEach(perm => {
                const instance = {
                    name: perm.name,
                    hasBasicAccess: false,
                    hasStorageAccess: false,
                    storageDetails: null
                };
                
                // Check basic monitoring permissions (PVEAuditor level)
                if (perm.canConnect && perm.canListNodes && perm.canListVMs && 
                    perm.canListContainers && perm.canGetNodeStats) {
                    instance.hasBasicAccess = true;
                    report.permissionAnalysis.details.canMonitorCore = true;
                    report.permissionAnalysis.details.canViewSnapshots = true; // Snapshots come from VM/CT config
                }
                
                // Check storage backup access (requires Datastore.Allocate)
                if (perm.canAccessStorageBackups && perm.storageBackupAccess) {
                    instance.hasStorageAccess = true;
                    report.permissionAnalysis.hasStorageAccess = true;
                    report.permissionAnalysis.details.canViewPveBackups = true;
                    
                    instance.storageDetails = {
                        accessible: perm.storageBackupAccess.accessibleStorages,
                        total: perm.storageBackupAccess.totalStoragesTested
                    };
                }
                
                report.permissionAnalysis.pveInstances.push(instance);
            });
        }
        
        // Analyze PBS permissions
        if (report.permissions && report.permissions.pbs && Array.isArray(report.permissions.pbs)) {
            report.permissions.pbs.forEach(perm => {
                const instance = {
                    name: perm.name,
                    hasAccess: false
                };
                
                if (perm.canConnect && perm.canListDatastores && perm.canListBackups) {
                    instance.hasAccess = true;
                    report.permissionAnalysis.details.canViewPbsBackups = true;
                }
                
                report.permissionAnalysis.pbsInstances.push(instance);
            });
        }
        
        // Determine overall mode
        const hasAnyPveInstance = report.permissionAnalysis.pveInstances.length > 0;
        const hasBasicPveAccess = report.permissionAnalysis.pveInstances.some(i => i.hasBasicAccess);
        const hasStorageAccess = report.permissionAnalysis.pveInstances.some(i => i.hasStorageAccess);
        
        if (!hasAnyPveInstance) {
            report.permissionAnalysis.mode = 'not_configured';
        } else if (!hasBasicPveAccess) {
            report.permissionAnalysis.mode = 'insufficient';
        } else if (hasStorageAccess) {
            report.permissionAnalysis.mode = 'extended';
        } else {
            report.permissionAnalysis.mode = 'secure';
        }
        
        // Don't add recommendations here - we'll show the comparison in the main table
    }

    generateRecommendations(report) {
        // Check for overly permissive tokens and security concerns
        if (report.permissions) {
            // Check Proxmox tokens
            if (report.permissions.proxmox && Array.isArray(report.permissions.proxmox)) {
                report.permissions.proxmox.forEach(perm => {
                    // Check for root token usage
                    if (perm.tokenId && perm.tokenId.startsWith('root@')) {
                        report.recommendations.push({
                            severity: 'warning',
                            category: 'Security: Root User Token',
                            message: `Proxmox "${perm.name}": Using root user token (${perm.tokenId.split('!')[0]}). While tokens can limit root's permissions through roles, using a dedicated monitoring user is recommended for defense in depth.\n\nBenefits of a dedicated user:\n• Clear audit trail of monitoring activities\n• Can be disabled without affecting root access\n• Follows principle of least privilege\n• Reduces risk if token is compromised\n\nSee README "Security Best Practices" section for setup instructions.`
                        });
                    }
                    
                    // Check if they have more permissions than needed
                    // If they can access backups AND have all other permissions, they likely have admin rights
                    if (perm.canConnect && perm.canListNodes && perm.canListVMs && 
                        perm.canListContainers && perm.canGetNodeStats && 
                        perm.canListStorage && perm.canAccessStorageBackups) {
                        
                        // Check if it's an admin token (has version info which requires Sys.Audit)
                        if (perm.version && !perm.tokenId.startsWith('root@')) {
                            report.recommendations.push({
                                severity: 'info',
                                category: 'Security: Permissions Review',
                                message: `Proxmox "${perm.name}": Token appears to have full permissions. While Pulse requires PVEDatastoreAdmin for backup visibility (an unfortunate necessity), ensure your token doesn't have unnecessary admin rights like:\n• VM.Allocate (create/delete VMs)\n• Sys.Modify (modify system settings)\n• Permissions.Modify (change permissions)\n\nPulse requires:\n• PVEAuditor role on '/' (provides Datastore.Audit, Mapping.Audit, Pool.Audit, SDN.Audit, Sys.Audit, VM.Audit)\n• PVEDatastoreAdmin on '/storage' (provides Datastore.Allocate needed for listing backup files)`
                            });
                        }
                    }
                    
                    // Only explain PVEDatastoreAdmin requirement if NOT in secure mode
                    if (report.permissionAnalysis && report.permissionAnalysis.mode !== 'secure' &&
                        perm.canListStorage && !perm.canAccessStorageBackups && 
                        perm.storageBackupAccess && perm.storageBackupAccess.totalStoragesTested > 0) {
                        // They already get a critical error, but add an explanation
                        report.recommendations.push({
                            severity: 'info',
                            category: 'Permission Requirement Explanation',
                            message: `Why PVEDatastoreAdmin is needed: The Proxmox API endpoint /nodes/{node}/storage/{storage}/content requires the 'Datastore.Allocate' permission to list backup files. This permission is only available in the PVEDatastoreAdmin or PVEAdmin roles. While PVEDatastoreAdmin includes write permissions that Pulse doesn't use, it's the least privileged role that can view storage contents via the API. This is a documented limitation of the Proxmox API permission model.`
                        });
                    }
                });
            }
            
            // Check PBS tokens
            if (report.permissions.pbs && Array.isArray(report.permissions.pbs)) {
                report.permissions.pbs.forEach(perm => {
                    // Check for root token usage
                    if (perm.tokenId && perm.tokenId.startsWith('root@')) {
                        report.recommendations.push({
                            severity: 'warning',
                            category: 'Security: Root User Token',
                            message: `PBS "${perm.name}": Using root user token (${perm.tokenId.split('!')[0]}). While tokens can limit root's permissions through roles, using a dedicated monitoring user is recommended for defense in depth.\n\nBenefits of a dedicated user:\n• Clear audit trail of monitoring activities\n• Can be disabled without affecting root access\n• Follows principle of least privilege\n• Reduces risk if token is compromised`
                        });
                    }
                    
                    // PBS permissions are simpler - we only need Datastore.Audit
                    if (perm.canConnect && perm.canListDatastores && perm.canListBackups) {
                        // Check if token might have excessive permissions (heuristic since we can't query permissions with another token)
                        // Skip this check for root tokens (already warned above) and read-only named tokens
                        const tokenName = perm.tokenId.split('!')[1] || '';
                        const isLikelyReadOnly = tokenName.toLowerCase().includes('read') || 
                                               tokenName.toLowerCase().includes('audit') || 
                                               tokenName.toLowerCase().includes('monitor');
                        
                        if (!perm.tokenId.startsWith('root@') && !isLikelyReadOnly && perm.version) {
                            report.recommendations.push({
                                severity: 'info',
                                category: 'Security: Permissions Review',
                                message: `PBS "${perm.name}": Token appears to have full access. If this token has Admin role, consider restricting to only Datastore.Audit permissions. Pulse only needs read access to monitor backups.`
                            });
                        }
                    }
                });
            }
        }
        
        // Check permission test results
        if (report.permissions) {
            // Check Proxmox permissions
            if (report.permissions.proxmox && Array.isArray(report.permissions.proxmox)) {
                report.permissions.proxmox.forEach(perm => {
                    if (!perm.canConnect) {
                        report.recommendations.push({
                            severity: 'critical',
                            category: 'Proxmox Connection',
                            message: `Cannot connect to Proxmox "${perm.name}" at ${perm.host}. Check your host, credentials, and network connectivity. Errors: ${perm.errors.join(', ')}`
                        });
                    } else {
                        // Check individual permissions
                        if (!perm.canListNodes) {
                            report.recommendations.push({
                                severity: 'critical',
                                category: 'Proxmox Permissions',
                                message: `Proxmox "${perm.name}": Token cannot list nodes. The PVEAuditor role on '/' (which includes Sys.Audit permission) is recommended for basic monitoring.`
                            });
                        }
                        if (!perm.canListVMs) {
                            report.recommendations.push({
                                severity: 'critical',
                                category: 'Proxmox Permissions', 
                                message: `Proxmox "${perm.name}": Token cannot list VMs. The PVEAuditor role on '/' (which includes VM.Audit permission) is recommended for basic monitoring.`
                            });
                        }
                        if (!perm.canListContainers) {
                            report.recommendations.push({
                                severity: 'critical',
                                category: 'Proxmox Permissions',
                                message: `Proxmox "${perm.name}": Token cannot list containers. The PVEAuditor role on '/' (which includes VM.Audit permission) is recommended for basic monitoring.`
                            });
                        }
                        if (!perm.canGetNodeStats) {
                            report.recommendations.push({
                                severity: 'warning',
                                category: 'Proxmox Permissions',
                                message: `Proxmox "${perm.name}": Token cannot get node statistics. This may affect metrics collection. The PVEAuditor role includes the necessary permissions.`
                            });
                        }
                        if (!perm.canListStorage) {
                            report.recommendations.push({
                                severity: 'warning',
                                category: 'Proxmox Permissions',
                                message: `Proxmox "${perm.name}": Token cannot list storage. This may affect backup discovery. The PVEAuditor role includes the necessary permissions.`
                            });
                        }
                        if (perm.canListStorage && !perm.canAccessStorageBackups) {
                            // Only show storage permission info if NOT in secure mode
                            // In secure mode, not seeing storage backups is intentional
                            if (report.permissionAnalysis && report.permissionAnalysis.mode !== 'secure') {
                                const storageAccess = perm.storageBackupAccess;
                                if (storageAccess && storageAccess.totalStoragesTested > 0) {
                                    const inaccessibleStorages = storageAccess.totalStoragesTested - storageAccess.accessibleStorages;
                                    if (inaccessibleStorages > 0) {
                                        report.recommendations.push({
                                            severity: 'critical',
                                            category: 'Proxmox Storage Permissions',
                                            message: `Proxmox "${perm.name}": Token cannot access backup content in ${inaccessibleStorages} of ${storageAccess.totalStoragesTested} backup-enabled storages. This prevents PVE backup discovery.\n\nThe Proxmox API requires 'Datastore.Allocate' permission to list storage contents via the API. This permission is included in the PVEDatastoreAdmin role.\n\nMost likely cause: Token has privilege separation enabled (default) but permissions were set on the token instead of the user.\n\nTo fix:\n1. Check token's privsep setting: pveum user token list <username> --output-format json\n2. If privsep=1: pveum acl modify /storage --users <username> --roles PVEDatastoreAdmin\n3. If privsep=0: pveum acl modify /storage --tokens <token-id> --roles PVEDatastoreAdmin\n\nSee README "Storage Content Visibility" section for details.`
                                        });
                                    }
                                } else {
                                    report.recommendations.push({
                                        severity: 'info',
                                        category: 'Proxmox Storage',
                                        message: `Proxmox "${perm.name}": No backup-enabled storage found to test. If you have backup storage configured, ensure it has 'backup' in its content types.`
                                    });
                                }
                            }
                        }
                        // Don't add success messages - the permission analysis already shows what's working
                    }
                });
            }

            // Check PBS permissions
            if (report.permissions.pbs && Array.isArray(report.permissions.pbs)) {
                report.permissions.pbs.forEach(perm => {
                    if (!perm.canConnect) {
                        report.recommendations.push({
                            severity: 'critical',
                            category: 'PBS Connection',
                            message: `Cannot connect to PBS "${perm.name}" at ${perm.host}. Check your host, credentials, and network connectivity. Errors: ${perm.errors.join(', ')}`
                        });
                    } else {
                        if (!perm.canListDatastores) {
                            report.recommendations.push({
                                severity: 'critical',
                                category: 'PBS Permissions',
                                message: `PBS "${perm.name}": Token cannot list datastores. Grant 'Datastore.Audit' permission on '/' or specific datastore paths. Note: PBS tokens do NOT inherit permissions from users - you must explicitly grant permissions to the token using --auth-id 'user@realm!token'.`
                            });
                        }
                        if (!perm.canListBackups && perm.canListDatastores) {
                            report.recommendations.push({
                                severity: 'warning',
                                category: 'PBS Permissions',
                                message: `PBS "${perm.name}": Token can list datastores but not backup snapshots. Ensure the token has 'Datastore.Audit' permission on the specific datastores, not just on '/'.`
                            });
                        }
                    }
                    
                    // Node name is now auto-discovered, no need to check for it
                    
                    
                    // Don't add success messages for PBS either - permission analysis shows what's working
                });
            }
        }

        if (report.configuration && report.configuration.pbs && Array.isArray(report.configuration.pbs)) {
            // Node name is now auto-discovered, no need to check for it
        }

        // Check if there are backups but no guests
        if (report.state && report.state.pbs && report.state.guests) {
            if (report.state.pbs.totalBackups > 0 && report.state.guests.total === 0) {
                // Check if it's just a timing issue
                if (report.state.loadTimeout) {
                    report.recommendations.push({
                        severity: 'critical',
                        category: 'Discovery Issue',
                        message: `No data loaded after waiting ${report.state.waitTime}s. The discovery cycle is not completing. Check server logs for errors with Proxmox API connections.`
                    });
                } else if (report.state.dataAge === null) {
                    const uptime = Math.floor(report.state.serverUptime || 0);
                    // This shouldn't happen now since we wait for data
                    report.recommendations.push({
                        severity: 'warning',
                        category: 'Unexpected State',
                        message: `Data loading state is unclear (server uptime: ${uptime}s). Try running diagnostics again.`
                    });
                } else if (report.state.serverUptime < 60) {
                    report.recommendations.push({
                        severity: 'info',
                        category: 'Data Loading',
                        message: `Server recently started (${Math.floor(report.state.serverUptime || 0)}s ago). Data may still be loading. Please wait a moment and try again.`
                    });
                } else {
                    report.recommendations.push({
                        severity: 'critical',
                        category: 'Data Issue',
                        message: 'PBS has backups but no VMs/containers are detected. Check if your Proxmox API token has proper permissions to list VMs and containers.'
                    });
                }
            }

            // Check if PBS is configured but no backups found
            if (report.state.pbs.instances > 0 && report.state.pbs.totalBackups === 0) {
                report.recommendations.push({
                    severity: 'warning',
                    category: 'PBS Data',
                    message: 'PBS is configured but no backups were found. Verify that backups exist in your PBS datastores and that the API token has permission to read them.'
                });
            }
        }
        
        // Check PVE backups
        if (report.state && report.state.pveBackups) {
            const totalPveBackups = (report.state.pveBackups.backupTasks || 0) + 
                                  (report.state.pveBackups.storageBackups || 0);
            const totalPveSnapshots = report.state.pveBackups.guestSnapshots || 0;
            
            // Check for storage discovery issues - but not in secure mode where it's expected
            if (report.permissionAnalysis && report.permissionAnalysis.mode !== 'secure' &&
                report.state.pveBackups.backupTasks > 0 && report.state.pveBackups.storageBackups === 0) {
                // We have backup tasks but no storage backups found
                let storageIssue = false;
                let hasBackupStorage = false;
                
                if (report.state.storageDebug && report.state.storageDebug.storageByNode) {
                    report.state.storageDebug.storageByNode.forEach(nodeInfo => {
                        const backupStorages = nodeInfo.storages.filter(s => s.hasBackupContent && s.type !== 'pbs');
                        if (backupStorages.length > 0) {
                            hasBackupStorage = true;
                        }
                    });
                }
                
                if (hasBackupStorage) {
                    report.recommendations.push({
                        severity: 'warning',
                        category: 'Storage Access',
                        message: `Found ${report.state.pveBackups.backupTasks} backup tasks but 0 storage backups. This suggests backup files exist but cannot be read. Check that the Pulse API user has 'Datastore.Audit' or 'Datastore.AllocateSpace' permissions on your backup storage.`
                    });
                } else {
                    report.recommendations.push({
                        severity: 'info',
                        category: 'Storage Configuration',
                        message: `Found ${report.state.pveBackups.backupTasks} backup tasks but no non-PBS storage configured for backups. If you're using PBS exclusively, this is normal. Otherwise, check your storage configuration.`
                    });
                }
            }
            
            // If no PBS configured but PVE backups exist, that's fine
            if ((!report.state.pbs || report.state.pbs.instances === 0) && totalPveBackups > 0) {
                report.recommendations.push({
                    severity: 'info',
                    category: 'Backup Status',
                    message: `Found ${totalPveBackups} PVE backups and ${totalPveSnapshots} VM/CT snapshots. Note: PBS is not configured, showing only local PVE backups.`
                });
            }
        }

        // Check namespace filtering for multiple PBS instances
        if (report.state && report.state.namespaceFilteringDebug) {
            const debug = report.state.namespaceFilteringDebug;
            if (debug.multiplePbsInstances && debug.sharedNamespaces.length > 0) {
                report.recommendations.push({
                    severity: 'info',
                    category: 'PBS Namespace Filtering',
                    message: `Multiple PBS instances detected (${debug.pbsInstanceCount}) with shared namespaces. Shared namespaces: ${debug.sharedNamespaces.map(ns => `${ns.namespace} (${ns.instances.join(', ')})`).join(', ')}. When filtering by namespace, backups from ALL PBS instances with that namespace will be shown.`
                });
                
                // Add detailed namespace backup distribution info
                if (debug.currentFilters.namespace !== 'all' && debug.currentFilters.namespace !== null) {
                    const namespaceData = debug.sharedNamespaces.find(ns => ns.namespace === debug.currentFilters.namespace);
                    if (namespaceData && namespaceData.instances.length > 1) {
                        const breakdown = Object.entries(namespaceData.perInstanceCounts || {})
                            .map(([instance, count]) => `${instance}: ${count}`)
                            .join(', ');
                        report.recommendations.push({
                            severity: 'info',
                            category: 'PBS Namespace Filter Active',
                            message: `Currently filtering by namespace "${debug.currentFilters.namespace}" which exists on ${namespaceData.instances.length} PBS instances. Backup distribution: ${breakdown}. Total backups in this namespace: ${namespaceData.totalBackups}.`
                        });
                    }
                }
            }
        }

        // Check guest count
        if (report.state && report.state.guests && report.state.nodes) {
            if (report.state.guests.total === 0 && report.state.nodes.count > 0) {
                // Only add this recommendation if we haven't already identified it as a timing/loading issue
                const hasTimingRec = report.recommendations.some(r => 
                    r.category === 'Data Loading' || r.category === 'Discovery Issue'
                );
                
                if (!hasTimingRec) {
                    report.recommendations.push({
                        severity: 'warning',
                        category: 'Proxmox Data',
                        message: 'No VMs or containers found despite having Proxmox nodes. This could be a permissions issue with your Proxmox API token.'
                    });
                }
            }
        }

        // Add security summary if we have tokens configured
        if (report.permissions && 
            ((report.permissions.proxmox && report.permissions.proxmox.length > 0) || 
             (report.permissions.pbs && report.permissions.pbs.length > 0))) {
            
            let hasRootTokens = false;
            let hasOverlyPermissive = false;
            
            // Check for security issues
            report.recommendations.forEach(rec => {
                if (rec.category && rec.category.includes('Root User Token')) hasRootTokens = true;
                if (rec.category && rec.category.includes('Permissions Review')) hasOverlyPermissive = true;
            });
            
            // Don't add redundant security messages - permission analysis already shows this
        }
        
        // Add focused security recommendation for Extended Mode users
        if (report.permissionAnalysis && report.permissionAnalysis.mode === 'extended') {
            // Get the actual token user from the first PVE instance
            let tokenUser = 'your-user@pam';
            if (report.permissions && report.permissions.proxmox && report.permissions.proxmox.length > 0) {
                const firstPve = report.permissions.proxmox[0];
                if (firstPve.tokenId) {
                    // Extract just the user part (before the !)
                    tokenUser = firstPve.tokenId.split('!')[0];
                }
            }
            
            report.recommendations.push({
                severity: 'info',
                category: 'Security Trade-off Information',
                message: `<strong>Understanding Your Current Permission Mode</strong>

You're using Extended Mode to view PVE local storage backups. This requires the PVEDatastoreAdmin role due to how Proxmox's API works.

<strong>What this means:</strong>
• ✅ You can see .vma backup files in PVE local storage
• ⚠️ Your token has write permissions (Datastore.Allocate) that Pulse doesn't use
• ℹ️ This is a Proxmox API limitation, not a Pulse design choice

<strong>Security considerations:</strong>
The PVEDatastoreAdmin role includes permissions to:
• Create or delete storage locations
• Modify storage configurations
• Upload or delete backup files

While Pulse never uses these write permissions, they exist on your token.

<strong>Your options:</strong>
1. <strong>Keep Extended Mode</strong> if viewing PVE storage backups is important to you
2. <strong>Switch to Secure Mode</strong> if you primarily use PBS or don't need to see .vma files

<strong>To switch to Secure Mode (optional):</strong>
<code style="font-family: monospace;">pveum acl modify /storage --delete --users ${tokenUser}</code>

This removes storage permissions. After running this command:
• ❌ PVE storage backups will no longer appear in the Backups tab
• ✅ All other features continue working normally
• ✅ PBS backups remain fully visible

<strong>Note:</strong> There's no "right" choice here - it depends on your monitoring needs and security preferences.`
            });
        }
        
        // Add informational message for Secure Mode users about how to enable PVE backups if needed
        if (report.permissionAnalysis && report.permissionAnalysis.mode === 'secure') {
            // Check if there are any PVE instances configured
            const hasPveInstances = report.permissions && report.permissions.proxmox && report.permissions.proxmox.length > 0;
            
            if (hasPveInstances) {
                const tokenId = report.permissions.proxmox[0].tokenId || '';
                const username = tokenId ? tokenId.split('!')[0] : 'your-user@pam';
                const tokenName = tokenId ? tokenId.split('!')[1] : '';
                
                // For tokens with privsep=0, permissions go on the user
                // For tokens with privsep=1, permissions would go on the token
                // Since most Pulse users use noprivsep tokens, default to user permissions
                report.recommendations.push({
                    severity: 'info',
                    category: 'Current Mode: Secure',
                    message: `You're in Secure Mode with read-only access. PVE storage backups are not visible in this mode.

<strong>If you need to see PVE storage backups:</strong>
Grant the PVEDatastoreAdmin role on /storage:

<code style="font-family: monospace;">pveum acl modify /storage --users ${username} --roles PVEDatastoreAdmin</code>

Note: This grants write permissions that Pulse doesn't use, but is required by Proxmox to view storage contents.
${tokenName === 'noprivsep' ? '(Your token has privilege separation disabled, so permissions are set on the user)' : ''}`
                });
            }
        }
        
        // Don't add generic success messages - recommendations should only show actual issues
    }

    sanitizeUrl(url) {
        if (!url) return 'Not configured';
        
        // Handle URLs that may not have protocol
        let urlToParse = url;
        if (!url.includes('://')) {
            urlToParse = 'https://' + url;
        }
        
        try {
            const parsed = new URL(urlToParse);
            // Anonymize hostname/IP but keep protocol and port structure
            const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
            
            // Check if hostname is an IP address
            const isIP = /^(?:\d{1,3}\.){3}\d{1,3}$/.test(parsed.hostname);
            const anonymizedHost = isIP ? 'REDACTED-IP' : 'REDACTED-HOST';
            
            // Only include port if it's non-standard
            if ((parsed.protocol === 'https:' && port === '443') || 
                (parsed.protocol === 'http:' && port === '80')) {
                return `${parsed.protocol}//${anonymizedHost}`;
            }
            return `${parsed.protocol}//${anonymizedHost}:${port}`;
        } catch {
            // Fallback for malformed URLs - sanitize more aggressively
            return url
                .replace(/\/\/[^:]+:[^@]+@/, '//REDACTED:REDACTED@')
                .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, 'REDACTED-IP')
                .replace(/:[0-9]{2,5}/g, ':PORT')
                .replace(/[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*/g, 'REDACTED-HOST');
        }
    }
}

module.exports = DiagnosticTool;