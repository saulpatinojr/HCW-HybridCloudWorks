export const azureArchitectures = {
  'secure-2-tier-azure': {
    title: 'Secure 2-Tier Application on Azure',
    category: 'Security & Networking',
    complexity: 'Level 300',
    description:
      'A simple, secure and scalable two-tier web and data architecture on Azure using Application Gateway with WAF, segmented VNet subnets with NSGs, and Private Link to Azure SQL.',
    promise:
      'A simple, secure and scalable architecture using Application Gateway with WAF, segmented VNet subnets with NSGs, and a Private Endpoint to Azure SQL.',
    estimatedCost: '$680 - $1,250 / month',
    topology: {
      caption: 'Request flow across the Azure Resource Group & Virtual Network boundary',
      surrounding: [
        'Microsoft Entra ID',
        'Azure Key Vault',
        'Log Analytics Workspace',
        'Resource Group',
      ],
      stages: [
        {
          id: 'users-internet',
          title: 'Users & Internet',
          subtitle: 'HTTPS (TLS 1.2+) client traffic entering over the public edge.',
          boundary: 'Edge',
          guardrail: 'DNS + TLS 1.2+',
        },
        {
          id: 'app-gateway-waf',
          title: 'Application Gateway + WAF',
          subtitle: 'Layer-7 load balancer running OWASP CRS rules in Prevention mode.',
          boundary: 'Ingress Subnet',
          guardrail: 'WAF v2 Prevention',
        },
        {
          id: 'web-subnet',
          title: 'Web Tier Subnet',
          subtitle: 'App Service / compute instances isolated behind a dedicated Web NSG.',
          boundary: 'VNet · Web NSG',
          guardrail: 'Allow 443 from AppGW only',
        },
        {
          id: 'db-subnet',
          title: 'Database Tier Subnet',
          subtitle: 'Dedicated data subnet locked down with a strict Database NSG.',
          boundary: 'VNet · DB NSG',
          guardrail: 'Allow 1433 from Web Subnet',
        },
        {
          id: 'private-endpoint-sql',
          title: 'Private Endpoint → Azure SQL',
          subtitle: 'Private Link NIC mapped via Private DNS Zone to Azure SQL Database.',
          boundary: 'Private Link',
          guardrail: 'Public access disabled',
        },
      ],
    },
    hotspots: [
      {
        id: 'spot-waf',
        x: 22,
        y: 45,
        label: 'Application Gateway with WAF v2',
        description:
          'Inspects inbound HTTP/HTTPS requests against OWASP Core Rule Set before forwarding to the web subnet.',
      },
      {
        id: 'spot-web-nsg',
        x: 48,
        y: 45,
        label: 'Web Subnet & NSG',
        description:
          'Accepts traffic only from the Application Gateway subnet and uses Managed Identity to read secrets from Key Vault.',
      },
      {
        id: 'spot-sql-pe',
        x: 78,
        y: 45,
        label: 'Private Endpoint to Azure SQL',
        description:
          'Routes SQL traffic over a private IP inside the database subnet with public network access disabled on the logical SQL server.',
      },
    ],
    howItWorks: [
      'Users send HTTPS requests from the internet to the public frontend IP of Azure Application Gateway.',
      'Web Application Firewall (WAF v2) inspects each request against OWASP rules and blocks malicious payloads at the edge.',
      'Application Gateway forwards clean traffic into the Virtual Network to the Web Subnet, where a Network Security Group (NSG) permits ingress only from the gateway subnet.',
      'The web tier authenticates to Microsoft Entra ID using a system-assigned Managed Identity and retrieves certificates and configuration from Azure Key Vault.',
      'Database queries travel from the Web Subnet to the Database Subnet, where a second NSG allows port 1433 only from the Web Subnet.',
      'A Private Endpoint in the Database Subnet connects privately over Azure backbone to Azure SQL Database with public network access turned off.',
      'Diagnostic logs and metrics from Application Gateway, NSG flow logs, Web Tier, and Azure SQL stream continuously into Log Analytics.',
    ],
    keyServices: [
      {
        name: 'Azure Application Gateway (WAF v2)',
        icon: 'shield',
        role: 'Terminates TLS and filters Layer-7 web traffic with OWASP rules before it enters the application tier.',
      },
      {
        name: 'Azure Virtual Network & NSGs',
        icon: 'hub',
        role: 'Segments ingress, web, and database tiers into isolated subnets with least-privilege network security rules.',
      },
      {
        name: 'Azure Private Endpoint',
        icon: 'lock',
        role: 'Brings Azure SQL Database onto a private VNet IP address so database traffic never traverses the public internet.',
      },
      {
        name: 'Azure SQL Database',
        icon: 'database',
        role: 'Managed relational data tier with Entra-only authentication, zone redundancy, and automated backups.',
      },
      {
        name: 'Microsoft Entra ID',
        icon: 'badge',
        role: 'Provides passwordless Managed Identity authentication between the web tier, Key Vault, and Azure SQL.',
      },
      {
        name: 'Azure Key Vault',
        icon: 'key',
        role: 'Stores TLS certificates and application secrets behind RBAC and private network controls.',
      },
      {
        name: 'Azure Monitor & Log Analytics',
        icon: 'monitoring',
        role: 'Centralizes WAF logs, NSG flow telemetry, and SQL audit trails for operational visibility and alerting.',
      },
    ],
    practices: [
      'Run Application Gateway WAF v2 in Prevention mode with bot protection and rate limiting enabled.',
      'Enforce explicit deny-all baseline rules on both the Web Subnet NSG and Database Subnet NSG.',
      'Disable public network access (`public_network_access_enabled = false`) on Azure SQL and Key Vault.',
      'Use Microsoft Entra Managed Identities instead of connection-string passwords for Web-to-SQL and Web-to-Key-Vault access.',
      'Send WAF, NSG, and SQL audit diagnostics to a single Log Analytics workspace with retention policies.',
    ],
    outcome: [
      'Delivers a production-ready, zero-public-database 2-tier Azure workload where every network hop is filtered by WAF or NSGs and authenticated with Entra Managed Identities.',
      'Gives platform and application teams repeatable Terraform IaC and clear operational telemetry in Log Analytics from day one.',
    ],
    overview: `
      <h2>Architecture Overview</h2>
      <p>The <strong>Secure 2-Tier Application on Azure</strong> pattern isolates public web ingress from private relational data inside a single Resource Group and Virtual Network. All incoming traffic enters through <strong>Azure Application Gateway with WAF v2</strong>, traverses a segmented <strong>Web Subnet</strong> and <strong>Database Subnet</strong> guarded by dedicated <strong>Network Security Groups (NSGs)</strong>, and reaches <strong>Azure SQL Database</strong> exclusively through an <strong>Azure Private Endpoint</strong>.</p>
      <h3>Surrounding Control Plane</h3>
      <ul>
        <li><strong>Microsoft Entra ID:</strong> Assigns Managed Identities to the web tier so no SQL passwords or vault keys are stored in application code.</li>
        <li><strong>Azure Key Vault:</strong> Holds TLS certificates for Application Gateway and runtime secrets for the web tier.</li>
        <li><strong>Log Analytics Workspace:</strong> Collects WAF detections, VNet flow logs, and SQL audit events in one queryable sink.</li>
      </ul>
    `,
    waf: {
      security: 95,
      reliability: 90,
      performance: 88,
      cost: 84,
      operational: 92,
      pillars: {
        security: {
          score: 95,
          notes:
            'WAF v2 at the edge, subnet-level NSGs, Private Link to Azure SQL, and Entra Managed Identities.',
        },
        reliability: {
          score: 90,
          notes:
            'Zone-redundant Application Gateway and Azure SQL with automated point-in-time backups.',
        },
        performance: {
          score: 88,
          notes: 'Autoscaling web tier and connection pooling over low-latency Private Link.',
        },
        cost: {
          score: 84,
          notes: 'Right-sized vCore SQL tier and autoscaled App Gateway v2 capacity units.',
        },
        operational: {
          score: 92,
          notes: 'Centralized Log Analytics workspace and full Terraform infrastructure-as-code.',
        },
      },
    },
    terraformCode: `resource "azurerm_virtual_network" "app" {
  name                = "vnet-secure-2tier-prod"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  address_space       = ["10.20.0.0/16"]
}

resource "azurerm_subnet" "web" {
  name                 = "snet-web"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.app.name
  address_prefixes     = ["10.20.1.0/24"]
}

resource "azurerm_subnet" "db" {
  name                 = "snet-db"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.app.name
  address_prefixes     = ["10.20.2.0/24"]
}

resource "azurerm_private_endpoint" "sql" {
  name                = "pe-sql-2tier"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  subnet_id           = azurerm_subnet.db.id

  private_service_connection {
    name                           = "psc-sql-2tier"
    private_connection_resource_id = azurerm_mssql_server.main.id
    subresource_names              = ["sqlServer"]
    is_manual_connection           = false
  }
}`,
    deploymentSteps: [
      'Provision the Resource Group, Log Analytics Workspace, and Virtual Network with ingress, web, and database subnets.',
      'Attach the Web NSG and Database NSG to their respective subnets before deploying compute or data resources.',
      'Deploy Azure SQL Server with public_network_access_enabled = false and bind the Private Endpoint in snet-db.',
      'Deploy the Web Tier with a system-assigned Managed Identity granted access to Key Vault and Azure SQL.',
      'Provision Application Gateway WAF v2 with the TLS certificate from Key Vault and verify health probes.',
    ],
    costAnalysis: {
      estimatedMonthly: '$680 - $1,250 / month',
      notes:
        'Estimated for East US 2 production baseline (WAF v2 + 2 Web instances + 2 vCore General Purpose SQL).',
      optimizations: [
        'Use Azure Hybrid Benefit and 1- or 3-year reservations for Azure SQL Database vCores.',
        'Configure Application Gateway v2 minimum capacity units to scale down during off-peak hours.',
        'Set Log Analytics table-level retention and basic logs for verbose flow telemetry.',
      ],
      breakdown: [
        { label: 'Application Gateway WAF v2', share: '$260 / mo' },
        { label: 'Web Tier Compute', share: '$190 / mo' },
        { label: 'Azure SQL + Private Link', share: '$210 / mo' },
        { label: 'Key Vault & Log Analytics', share: '$45 / mo' },
      ],
    },
    tags: ['Two-Tier', 'WAF', 'Private Link', 'Zero Trust', 'Azure SQL'],
  },
  'enterprise-hub-spoke-landing-zone': {
    title: 'Enterprise Hub-and-Spoke Landing Zone',
    category: 'Networking',
    complexity: 'Level 400',
    description:
      'Reference architecture for centralized connectivity, policy-driven segmentation, and shared security services across enterprise subscriptions.',
    promise:
      'Centralized hub-and-spoke network topology with Azure Firewall inspection, Private DNS resolution, and policy guardrails across workload subscriptions.',
    estimatedCost: '$2,100 / month',
    howItWorks: [
      'On-premises and branch traffic terminates in the Connectivity Hub via ExpressRoute or VPN Gateway.',
      'Azure Firewall in the hub inspects east-west traffic between workload spokes and north-south egress.',
      'Spoke virtual networks peer to the hub with useRemoteGateways and user-defined routes forcing 0.0.0.0/0 to the hub firewall.',
      'Azure Private DNS Resolver in the hub resolves Private Link FQDNs across all peered spokes.',
      'Azure Policy assignments at the management group scope enforce allowed regions, NSGs on every subnet, and diagnostic settings.',
    ],
    keyServices: [
      {
        name: 'Azure Virtual Network & Peering',
        icon: 'hub',
        role: 'Connects isolated workload spokes to a shared transit hub without transitive spoke-to-spoke routing.',
      },
      {
        name: 'Azure Firewall Premium',
        icon: 'security',
        role: 'Provides centralized TLS inspection, IDPS, and FQDN filtering for spoke traffic.',
      },
      {
        name: 'Azure Policy',
        icon: 'policy',
        role: 'Applies management-group guardrails for tagging, Private Link DNS, and network compliance.',
      },
    ],
    practices: [
      'Place connectivity resources in a dedicated Connectivity subscription separate from workload spokes.',
      'Force all spoke egress through the hub firewall via user-defined routes (UDRs).',
      'Automate spoke provisioning using Azure Verified Modules (AVM) in Terraform.',
    ],
    outcome: [
      'Establishes a repeatable enterprise network foundation where every new workload spoke inherits centralized egress filtering, hybrid DNS, and Azure Policy guardrails.',
    ],
    overview: `
      <h2>Architecture Overview</h2>
      <p>The <strong>Enterprise Hub-and-Spoke Landing Zone</strong> separates shared transit, firewall inspection, and hybrid connectivity in a central hub VNet from workload spokes deployed across dedicated subscriptions.</p>
    `,
    terraformCode: `module "alz_connectivity" {
  source              = "Azure/avm-ptn-alz/azurerm"
  version             = "0.21.0"
  architecture_name   = "alz"
  location            = "eastus2"
  parent_resource_id  = data.azurerm_client_config.current.tenant_id
}`,
    tags: ['Landing Zone', 'Hub-and-Spoke', 'Azure Firewall', 'AVM'],
  },
  'azure-vmware-estate-migration': {
    title: 'Azure VMware Estate Migration',
    category: 'Migration',
    complexity: 'Level 200',
    description:
      'Phased migration blueprint using Azure VMware Solution, Recovery Services, and dependency mapping for low-risk cutovers.',
    promise:
      'Low-risk wave-by-wave migration from on-premises vSphere or Hyper-V into Azure using dependency discovery, sizing waves, and automated replication.',
    estimatedCost: '$1,400 / month',
    howItWorks: [
      'Export VM inventory, CPU/RAM utilization, disk IOPS, and TCP flow dependencies from the source estate.',
      'Group interdependent machines into migration waves and classify readiness and right-sized Azure SKUs.',
      'Replicate wave 1 non-production workloads using Azure Migrate appliance and validate in an isolated test VNet.',
      'Execute planned cutover windows with automated DNS and NSG updates.',
      'Enable Azure Arc, backup policies, and Microsoft Defender for Cloud post-cutover.',
    ],
    keyServices: [
      {
        name: 'Azure Migrate',
        icon: 'cloud_sync',
        role: 'Discovers on-premises inventory, dependencies, and replicates disks for staged cutovers.',
      },
      {
        name: 'Azure Recovery Services',
        icon: 'backup',
        role: 'Protects migrated VMs with immutable recovery points and cross-region restore.',
      },
    ],
    practices: [
      'Right-size overprovisioned on-premises VMs using 95th-percentile CPU and memory metrics before cutover.',
      'Keep coupled database and application tiers in the same migration wave to avoid cross-premises latency.',
      'Apply Azure Hybrid Benefit for Windows Server and SQL Server licences.',
    ],
    outcome: [
      'Reduces cutover risk and cloud waste by turning raw inventory CSVs into dependency-checked migration waves and right-sized Azure targets.',
    ],
    overview: `
      <h2>Architecture Overview</h2>
      <p>This pattern combines discovery data with wave planning and replication so on-premises estates move to Azure with predictable downtime and right-sized SKUs.</p>
    `,
    tags: ['Migration', 'VMware', 'Right-Sizing', 'Hybrid'],
  },
  'finops-guardrails-azure': {
    title: 'FinOps Guardrails for Azure Subscriptions',
    category: 'FinOps',
    complexity: 'Level 300',
    description:
      'Policy and budget-control pattern with Cost Management exports, Azure Policy enforcement, and automated anomaly alerts.',
    promise:
      'Continuous cost governance across Azure subscriptions using mandatory cost-center tags, scheduled FOCUS exports, and anomaly alerts.',
    estimatedCost: '$950 / month',
    howItWorks: [
      'Azure Policy requires environment, owner, and cost-center tags on every resource group at creation time and inherits them onto child resources.',
      'Cost Management exports daily amortized cost and usage data in FOCUS format to an Azure Storage account.',
      'Subscription and resource-group budgets evaluate actual and forecasted spend against monthly thresholds.',
      'Automated anomaly detection alerts engineering leads when daily spend deviates from baseline.',
      'Advisor right-sizing and unattached-disk policies flag idle resources for scheduled cleanup.',
    ],
    keyServices: [
      {
        name: 'Microsoft Cost Management',
        icon: 'monitoring',
        role: 'Tracks actual and forecasted spend, reservation utilization, and daily anomaly alerts.',
      },
      {
        name: 'Azure Policy',
        icon: 'policy',
        role: 'Blocks untagged deployments and restricts expensive VM SKU families in non-production subscriptions.',
      },
    ],
    practices: [
      'Export amortized cost data daily rather than relying on manual portal CSV downloads.',
      'Configure budget alerts at 50%, 80%, and 100% of actual spend plus 100% forecasted spend.',
      'Deny unapproved high-core or GPU VM SKUs in sandbox subscriptions via Azure Policy.',
    ],
    outcome: [
      'Gives engineering and finance teams 100% tag attribution and early anomaly alerts before monthly invoice surprises occur.',
    ],
    overview: `
      <h2>Architecture Overview</h2>
      <p>Automated FinOps guardrails combine preventive Azure Policy definitions with daily FOCUS cost exports and budget alerting.</p>
    `,
    tags: ['FinOps', 'Governance', 'Azure Policy', 'FOCUS'],
  },
  'global-data-tier-cosmos-sql': {
    title: 'Global Data Tier with Cosmos DB + SQL',
    category: 'Database',
    complexity: 'Level 400',
    description:
      'Multi-region data architecture combining Cosmos DB and Azure SQL with geo-replication and strict consistency controls.',
    promise:
      'Low-latency global reads and resilient transactional writes using multi-region Cosmos DB alongside Active Geo-Replicated Azure SQL.',
    estimatedCost: '$3,200 / month',
    howItWorks: [
      'Global users connect to the nearest regional application stamp via Azure Front Door.',
      'High-throughput operational documents and session state are read and written locally through Azure Cosmos DB multi-region accounts.',
      'Relational financial transactions commit to the primary Azure SQL Database and replicate asynchronously to a paired secondary region via Auto-Failover Groups.',
      'Private Endpoints in each regional VNet isolate both Cosmos DB and Azure SQL from the public internet.',
      'In a regional outage, Front Door shifts traffic and the SQL Failover Group promotes the secondary within seconds.',
    ],
    keyServices: [
      {
        name: 'Azure Cosmos DB',
        icon: 'database',
        role: 'Provides single-digit millisecond global reads and tunable consistency across regions.',
      },
      {
        name: 'Azure SQL Auto-Failover Groups',
        icon: 'sync_alt',
        role: 'Manages geo-replication and stable read-write / read-only listener endpoints across regions.',
      },
    ],
    practices: [
      'Use Session or Bounded Staleness consistency in Cosmos DB to balance latency and durability.',
      'Test regional failover drills regularly using the SQL Failover Group listener endpoints.',
      'Bind both data services to regional Private Endpoints with Private DNS integration.',
    ],
    outcome: [
      'Achieves sub-second RPO and sub-minute RTO for mission-critical global workloads without exposing data endpoints publicly.',
    ],
    overview: `
      <h2>Architecture Overview</h2>
      <p>Pairs globally distributed NoSQL storage with geo-replicated relational SQL behind regional Private Endpoints.</p>
    `,
    tags: ['Database', 'Multi-Region', 'High Availability', 'DR'],
  },
  'zero-trust-identity-control-plane': {
    title: 'Zero Trust Identity Control Plane',
    category: 'Security',
    complexity: 'Level 300',
    description:
      'Identity-first architecture using Entra ID, Conditional Access, PIM, and Defender for Cloud to enforce least privilege at scale.',
    promise:
      'Identity-as-the-perimeter control plane enforcing phishing-resistant MFA, just-in-time Privileged Identity Management, and workload identities.',
    estimatedCost: '$780 / month',
    howItWorks: [
      'Every human sign-in is evaluated by Microsoft Entra Conditional Access for device compliance, sign-in risk, and phishing-resistant MFA.',
      'Standing privileged roles are eliminated; operators activate time-bound roles through Privileged Identity Management (PIM) with approval and audit logging.',
      'CI/CD workflows and cloud services authenticate via Workload Identity Federation (OIDC) and Managed Identities with zero stored client secrets.',
      'Microsoft Defender for Cloud continuously assesses subscription posture and alerts on anomalous control-plane activity.',
      'Entra sign-in, audit, and PIM activation logs stream to Microsoft Sentinel / Log Analytics for correlation.',
    ],
    keyServices: [
      {
        name: 'Microsoft Entra Conditional Access',
        icon: 'verified_user',
        role: 'Evaluates user, device health, location, and real-time risk on every authentication request.',
      },
      {
        name: 'Privileged Identity Management (PIM)',
        icon: 'admin_panel_settings',
        role: 'Enforces just-in-time, approval-gated elevation for Azure RBAC and Entra directory roles.',
      },
      {
        name: 'Microsoft Defender for Cloud',
        icon: 'security',
        role: 'Monitors cloud security posture and detects suspicious identity and resource operations.',
      },
    ],
    practices: [
      'Replace all long-lived service principal client secrets with OIDC Workload Identity Federation.',
      'Require FIDO2 / passkey phishing-resistant MFA for all privileged role activations in PIM.',
      'Maintain two emergency break-glass accounts excluded from Conditional Access and monitored with high-severity alerts.',
    ],
    outcome: [
      'Eliminates standing admin privileges and static secrets across Azure subscriptions while maintaining an auditable trail of every elevation.',
    ],
    overview: `
      <h2>Architecture Overview</h2>
      <p>Establishes an identity-first Zero Trust perimeter across human administrators and automated workloads.</p>
    `,
    tags: ['Zero Trust', 'Entra ID', 'PIM', 'Security'],
  },
  'event-driven-serverless-mesh': {
    title: 'Event-Driven Serverless Integration Mesh',
    category: 'Serverless',
    complexity: 'Level 200',
    description:
      'Serverless integration pattern based on Event Grid, Functions, and Service Bus for near real-time distributed workflows.',
    promise:
      'Decoupled, scale-to-zero event mesh combining Azure Event Grid for reactive routing, Service Bus for durable queuing, and Azure Functions.',
    estimatedCost: '$420 / month',
    howItWorks: [
      'Domain producers and Azure resource events publish lightweight notifications to Azure Event Grid topics.',
      'Event Grid filters and fans out events to subscribers based on event type and subject prefix.',
      'High-value transactional commands land in Azure Service Bus queues with dead-lettering and duplicate detection.',
      'Azure Functions on Flex Consumption scale out automatically to process messages using Managed Identity authentication.',
      'Application Insights traces distributed correlation IDs end-to-end across producers, queues, and function invocations.',
    ],
    keyServices: [
      {
        name: 'Azure Event Grid',
        icon: 'bolt',
        role: 'Routes reactive pub/sub events with push delivery and declarative filtering.',
      },
      {
        name: 'Azure Service Bus',
        icon: 'swap_horiz',
        role: 'Provides enterprise message brokering with FIFO sessions, transactions, and dead-letter queues.',
      },
      {
        name: 'Azure Functions',
        icon: 'functions',
        role: 'Executes event-driven compute handlers that scale on queue depth.',
      },
    ],
    practices: [
      'Use Service Bus for commands requiring guaranteed at-least-once delivery and Event Grid for state-change notifications.',
      'Configure dead-letter queue alerts and idempotent message handlers in every Function consumer.',
      'Authenticate Function triggers to Service Bus and Event Grid with Managed Identities (`__fullyQualifiedNamespace`).',
    ],
    outcome: [
      'Decouples microservices into resilient, independently scalable event consumers that pay only for actual execution.',
    ],
    overview: `
      <h2>Architecture Overview</h2>
      <p>Combines Event Grid push routing with Service Bus enterprise queuing and serverless compute handlers.</p>
    `,
    tags: ['Serverless', 'Event-Driven', 'Service Bus', 'Event Grid'],
  },
};

export const awsArchitectures = {
  'global-load-balancing': {
    title: 'Global Load Balancing',
    category: 'Networking',
    complexity: 'Level 300',
    description:
      'High-availability routing using ELB and Route 53 with multi-region failover and health checks.',
    promise:
      'Active-active multi-region traffic routing using Amazon Route 53 latency policies, AWS Global Accelerator, and regional Application Load Balancers.',
    estimatedCost: '$800 - $1,500 / month',
    howItWorks: [
      'Clients resolve the application domain through Amazon Route 53 using latency-based or geolocation routing.',
      'Route 53 health checks continuously probe regional Application Load Balancer (ALB) endpoints.',
      'AWS Global Accelerator ingests traffic at the nearest edge location over the AWS global backbone.',
      'Regional ALBs terminate TLS and distribute requests across healthy targets in multiple Availability Zones.',
      'If a region fails its health check, Route 53 and Global Accelerator shift traffic to healthy regions automatically.',
    ],
    keyServices: [
      {
        name: 'Amazon Route 53',
        icon: 'public',
        role: 'Directs users to the lowest-latency healthy region with automated DNS failover.',
      },
      {
        name: 'Application Load Balancer (ALB)',
        icon: 'hub',
        role: 'Terminates TLS and balances HTTP/HTTPS traffic across multi-AZ compute targets.',
      },
      {
        name: 'AWS Global Accelerator',
        icon: 'speed',
        role: 'Provides static anycast IPs and routes traffic over the AWS global network.',
      },
    ],
    practices: [
      'Configure Route 53 health checks against a deep application health endpoint rather than a shallow TCP check.',
      'Enable cross-zone load balancing and AWS WAF on every regional Application Load Balancer.',
      'Keep regional infrastructure definitions identical using Terraform modules.',
    ],
    outcome: [
      'Provides sub-minute regional failover and consistent low latency for globally distributed users.',
    ],
    overview: `
      <h2>Architecture Overview</h2>
      <p>This pattern provides global high availability for web applications by distributing traffic across multiple AWS Regions. It leverages <strong>AWS Route 53</strong> for DNS-based routing and <strong>Elastic Load Balancing (ELB)</strong> for local traffic distribution within each region.</p>
      <h3>Core Components</h3>
      <ul>
        <li><strong>Amazon Route 53:</strong> Uses Geolocation or Latency-based routing to direct users to the nearest healthy region.</li>
        <li><strong>Application Load Balancer (ALB):</strong> Terminates SSL/TLS and balances traffic across EC2 instances or containers in multiple Availability Zones.</li>
        <li><strong>AWS Global Accelerator:</strong> (Optional) Provides static IP addresses and routes traffic over the AWS global network for improved performance.</li>
      </ul>
    `,
    terraformCode: `resource "aws_route53_record" "www" {
  zone_id = aws_route53_zone.primary.zone_id
  name    = "example.com"
  type    = "A"

  alias {
    name                   = aws_lb.main.dns_name
    zone_id                = aws_lb.main.zone_id
    evaluate_target_health = true
  }
}`,
    tags: ['High Availability', 'Networking', 'Global'],
  },
  'multi-region-dr': {
    title: 'Multi-Region DR',
    category: 'Disaster Recovery',
    complexity: 'Level 400',
    description:
      'Active-Passive setup using RDS Aurora Global Database and S3 Cross-Region Replication for mission-critical apps.',
    promise:
      'Sub-second cross-region data replication and rapid regional recovery using Amazon Aurora Global Database and S3 Cross-Region Replication.',
    estimatedCost: '$3,000 - $5,000 / month',
    howItWorks: [
      'Primary region serves all read/write traffic through the active application tier and Aurora primary cluster.',
      'Aurora Global Database replicates storage changes asynchronously to the secondary region with typical lag under 1 second.',
      'Amazon S3 Cross-Region Replication (CRR) copies object writes and metadata to the standby regional bucket.',
      'Standby region maintains warm or pilot-light compute capacity defined by the same Terraform workspace.',
      'During a regional disaster, the secondary Aurora cluster is promoted to read/write and Route 53 cuts traffic over.',
    ],
    keyServices: [
      {
        name: 'Amazon Aurora Global Database',
        icon: 'database',
        role: 'Replicates database storage across regions with sub-second latency and fast promotion.',
      },
      {
        name: 'Amazon S3 Cross-Region Replication',
        icon: 'cloud_sync',
        role: 'Automatically replicates objects and KMS-encrypted assets to the DR region.',
      },
      {
        name: 'HashiCorp Terraform',
        icon: 'code',
        role: 'Maintains parity between primary and standby regional network and compute stacks.',
      },
    ],
    practices: [
      'Monitor Aurora Global Database replication lag (`AuroraGlobalDBReplicationLag`) with CloudWatch alarms.',
      'Use S3 Replication Time Control (S3 RTC) for compliance-critical object buckets.',
      'Run quarterly automated failover game days to verify RTO and DNS TTL behavior.',
    ],
    outcome: [
      'Protects mission-critical stateful workloads against full regional outages with < 1s RPO and predictable recovery runbooks.',
    ],
    overview: `
      <h2>Architecture Overview</h2>
      <p>A robust Disaster Recovery (DR) strategy ensuring business continuity even in the event of a full regional outage. This pattern follows an <strong>Active-Passive</strong> (Pilot Light or Warm Standby) approach.</p>
      <h3>Key Technologies</h3>
      <ul>
        <li><strong>RDS Aurora Global Database:</strong> Provides fast cross-region replication with typical latency of under 1 second.</li>
        <li><strong>S3 Cross-Region Replication (CRR):</strong> Automatically replicates objects across regions for data backup.</li>
        <li><strong>AWS CloudFormation/Terraform:</strong> Used to maintain identical infrastructure definitions across regions.</li>
      </ul>
    `,
    terraformCode: `resource "aws_rds_global_cluster" "example" {
  global_cluster_identifier = "global-test"
  engine                    = "aurora-mysql"
  engine_version            = "5.7.mysql_aurora.2.07.2"
  database_name             = "example_db"
}`,
    tags: ['Disaster Recovery', 'Enterprise', 'Compliance'],
  },
  'container-orchestration': {
    title: 'Container Orchestration',
    category: 'Containers',
    complexity: 'Level 300',
    description:
      'Modern microservices deployment on ECS Fargate with automated scaling and service discovery.',
    promise:
      'Serverless container microservices on Amazon ECS with AWS Fargate, per-task IAM isolation, and AWS Cloud Map service discovery.',
    estimatedCost: '$1,500 - $3,000 / month',
    howItWorks: [
      'Container images are built, scanned, and pushed with immutable digests.',
      'Amazon ECS schedules tasks onto AWS Fargate without EC2 node management.',
      'Each task receives its own elastic network interface (`awsvpc`) and a least-privilege IAM task role.',
      'Services register automatically in AWS Cloud Map for private service-to-service discovery.',
      'Application Auto Scaling adjusts desired task count based on ALB request rate or CPU/memory targets.',
    ],
    keyServices: [
      {
        name: 'Amazon ECS on AWS Fargate',
        icon: 'deployed_code',
        role: 'Runs isolated container tasks without provisioning or patching host instances.',
      },
      {
        name: 'AWS Cloud Map',
        icon: 'hub',
        role: 'Maintains dynamic DNS and health-checked service registry for internal microservices.',
      },
      {
        name: 'IAM Roles for Tasks',
        icon: 'verified_user',
        role: 'Scopes AWS API permissions to individual container tasks rather than shared nodes.',
      },
    ],
    practices: [
      'Pin container images by SHA-256 digest and run tasks as a non-root UID with read-only root filesystems.',
      'Place Fargate tasks in private subnets and route outbound traffic through NAT Gateways or VPC Endpoints.',
      'Use VPC Endpoints for ECR, CloudWatch Logs, and Secrets Manager to avoid public NAT charges.',
    ],
    outcome: [
      'Runs containerized microservices with strong task-level security boundaries and zero host patching overhead.',
    ],
    overview: `
      <h2>Architecture Overview</h2>
      <p>Leverage <strong>Amazon ECS with AWS Fargate</strong> to run containers without managing servers. This architecture is ideal for microservices that require rapid scaling and high isolation.</p>
      <h3>Key Features</h3>
      <ul>
        <li><strong>Serverless Compute:</strong> Fargate removes the need to provision or manage EC2 instances.</li>
        <li><strong>Service Discovery:</strong> Integrated with AWS Cloud Map for microservices communication.</li>
        <li><strong>IAM Roles for Tasks:</strong> Provides granular security permissions for each container service.</li>
      </ul>
    `,
    terraformCode: `resource "aws_ecs_service" "app" {
  name            = "my-app"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = 3
  launch_type     = "FARGATE"
}`,
    tags: ['Containers', 'Microservices', 'Fargate'],
  },
  'serverless-api': {
    title: 'Serverless API',
    category: 'Serverless',
    complexity: 'Level 200',
    description:
      'Cost-optimized event-driven backend using Lambda, API Gateway, and DynamoDB for massive scale.',
    promise:
      'Pay-per-request REST/HTTP backend using Amazon API Gateway, AWS Lambda, and Amazon DynamoDB with automatic scale-to-zero.',
    estimatedCost: '$0 - $500 / month (Pay-per-use)',
    howItWorks: [
      'Clients send HTTPS requests to Amazon API Gateway, which validates JWTs/authorizers and enforces throttling.',
      'API Gateway invokes stateless AWS Lambda functions scoped to the route.',
      'Lambda reads and writes single-digit millisecond items in Amazon DynamoDB using an execution role.',
      'DynamoDB Streams optionally trigger downstream asynchronous Lambda processors.',
      'CloudWatch Logs and AWS X-Ray capture structured request traces and cold-start metrics.',
    ],
    keyServices: [
      {
        name: 'Amazon API Gateway',
        icon: 'api',
        role: 'Manages routing, JWT authorization, request validation, and rate limiting.',
      },
      {
        name: 'AWS Lambda',
        icon: 'bolt',
        role: 'Executes stateless request handlers billed per millisecond of compute.',
      },
      {
        name: 'Amazon DynamoDB',
        icon: 'database',
        role: 'Provides serverless key-value and document storage with on-demand capacity scaling.',
      },
    ],
    practices: [
      'Grant each Lambda function a dedicated IAM role restricted to its specific DynamoDB table and actions.',
      'Enable Point-in-Time Recovery (PITR) on DynamoDB tables.',
      'Set explicit reserved concurrency and API Gateway usage plans to protect against traffic spikes.',
    ],
    outcome: [
      'Delivers a resilient API tier that costs nothing at idle and scales elastically to thousands of concurrent requests.',
    ],
    overview: `
      <h2>Architecture Overview</h2>
      <p>A fully serverless API architecture that scales automatically from zero to thousands of concurrent requests. Perfect for startups and event-driven workloads.</p>
      <h3>Core Stack</h3>
      <ul>
        <li><strong>Amazon API Gateway:</strong> Handles RESTful endpoints, authentication, and throttling.</li>
        <li><strong>AWS Lambda:</strong> Executes business logic only when triggered, minimizing idle costs.</li>
        <li><strong>Amazon DynamoDB:</strong> NoSQL database providing consistent, single-digit millisecond latency at any scale.</li>
      </ul>
    `,
    terraformCode: `resource "aws_lambda_function" "api_handler" {
  filename      = "lambda.zip"
  function_name = "api-handler"
  role          = aws_iam_role.iam_for_lambda.arn
  handler       = "index.handler"
  runtime       = "nodejs20.x"
}`,
    tags: ['Serverless', 'API', 'Cost-Effective'],
  },
  'data-lake': {
    title: 'Data Lake Architecture',
    category: 'Analytics',
    complexity: 'Level 300',
    description:
      'Scalable data storage and analytics pipeline using S3, Glue, and Athena for serverless queries.',
    promise:
      'Decoupled storage-and-compute analytics lakehouse on Amazon S3, AWS Glue Data Catalog, and Amazon Athena.',
    estimatedCost: '$500 - $1,200 / month',
    howItWorks: [
      'Raw events and batch files land in the bronze prefix of an encrypted Amazon S3 data lake bucket.',
      'AWS Glue Crawlers and ETL jobs normalize records into partitioned Parquet/Iceberg tables in the silver/gold prefixes.',
      'The AWS Glue Data Catalog records table schemas, partitions, and Lake Formation permissions.',
      'Analysts run standard SQL queries directly over S3 via Amazon Athena without provisioning clusters.',
      'S3 Intelligent-Tiering and lifecycle rules transition cold partitions to lower-cost storage classes.',
    ],
    keyServices: [
      {
        name: 'Amazon S3',
        icon: 'storage',
        role: 'Provides 11 nines of durability for raw and curated columnar datasets.',
      },
      {
        name: 'AWS Glue',
        icon: 'schema',
        role: 'Maintains the central metadata catalog and runs serverless Spark/Python transformations.',
      },
      {
        name: 'Amazon Athena',
        icon: 'Troubleshoot',
        role: 'Executes interactive serverless SQL queries directly against partitioned S3 objects.',
      },
    ],
    practices: [
      'Convert raw JSON/CSV data to compressed Parquet or Apache Iceberg and partition by date to minimize Athena scan cost.',
      'Block all public S3 access at the account and bucket levels and enforce KMS encryption.',
      'Set Athena workgroup per-query data scan limits to prevent runaway ad-hoc queries.',
    ],
    outcome: [
      'Enables petabyte-scale SQL analytics where storage and query compute scale independently.',
    ],
    overview: `
      <h2>Architecture Overview</h2>
      <p>Build a modern Data Lake on AWS to store vast amounts of raw data in its native format. This decoupled architecture allows you to scale storage and compute independently.</p>
      <h3>Workflow</h3>
      <ul>
        <li><strong>Ingestion:</strong> Data is collected in <strong>Amazon S3</strong> buckets.</li>
        <li><strong>Schema Discovery:</strong> <strong>AWS Glue Crawlers</strong> automatically discover data formats and populate the Glue Data Catalog.</li>
        <li><strong>Analysis:</strong> Use <strong>Amazon Athena</strong> to run SQL queries directly on data stored in S3.</li>
      </ul>
    `,
    terraformCode: `resource "aws_s3_bucket" "datalake" {
  bucket = "my-company-data-lake"
}

resource "aws_glue_catalog_database" "main" {
  name = "datalake_db"
}`,
    tags: ['Big Data', 'Analytics', 'Data Lake'],
  },
  'hybrid-connectivity': {
    title: 'Hybrid Connectivity',
    category: 'Connectivity',
    complexity: 'Level 400',
    description:
      'Secure enterprise connection via Direct Connect and Transit Gateway for hybrid cloud workloads.',
    promise:
      'Predictable private bandwidth between on-premises data centers and multi-VPC AWS estates using Direct Connect, Transit Gateway, and VPN backup.',
    estimatedCost: '$2,000 - $4,000 / month',
    howItWorks: [
      'Dedicated circuits from the on-premises router terminate at an AWS Direct Connect location over a Transit VIF.',
      'A Direct Connect Gateway aggregates regional AWS Transit Gateways across accounts and regions.',
      'Each workload VPC attaches to the regional Transit Gateway with segmented route tables.',
      'An AWS Site-to-Site VPN connection over the internet provides encrypted BGP failover if the physical circuit goes down.',
      'Route 53 Resolver inbound and outbound endpoints bridge DNS resolution between corporate Active Directory and private VPC zones.',
    ],
    keyServices: [
      {
        name: 'AWS Direct Connect',
        icon: 'settings_input_component',
        role: 'Delivers dedicated private fiber connectivity between on-premises routers and AWS.',
      },
      {
        name: 'AWS Transit Gateway',
        icon: 'hub',
        role: 'Acts as a regional cloud router connecting hundreds of VPCs and hybrid attachments.',
      },
      {
        name: 'AWS Site-to-Site VPN',
        icon: 'vpn_key',
        role: 'Provides automated encrypted backup routing over BGP when Direct Connect is degraded.',
      },
    ],
    practices: [
      'Terminate Direct Connect circuits in two distinct colocation facilities for physical diversity.',
      'Use MACsec or IPsec over Direct Connect when compliance mandates Layer-2/Layer-3 line encryption.',
      'Segment production and non-production VPC attachments into separate Transit Gateway route tables.',
    ],
    outcome: [
      'Unifies on-premises and multi-account AWS networking under a single hub router with automated BGP failover.',
    ],
    overview: `
      <h2>Architecture Overview</h2>
      <p>Connect your on-premises data centers to the AWS Cloud with consistent network performance and enhanced security using <strong>AWS Direct Connect</strong>.</p>
      <h3>Key Components</h3>
      <ul>
        <li><strong>Direct Connect (DX):</strong> Dedicated network connection from your premises to AWS.</li>
        <li><strong>AWS Transit Gateway:</strong> Connects thousands of VPCs and on-premises networks through a central hub.</li>
        <li><strong>Site-to-Site VPN:</strong> Used as a backup or secondary path for DX connections.</li>
      </ul>
    `,
    terraformCode: `resource "aws_ec2_transit_gateway" "main" {
  description = "Central transit gateway"
}`,
    tags: ['Networking', 'Hybrid Cloud', 'Enterprise'],
  },
};

export const architecturesByProvider = {
  aws: awsArchitectures,
  azure: azureArchitectures,
};
