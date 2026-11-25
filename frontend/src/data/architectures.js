import { AVM_MODULES } from '../lib/landingZone/avmVersions';

// The example below calls avm-ptn-alz, and its "Verify in 15-Min Browser Lab"
// button opens a lab whose image carries only the module versions the Landing
// Zone Builder pins. So the example reads its source and version from those
// pins instead of a typed-in number, which fell behind the weekly bump (#1604).
const ALZ_MODULE = AVM_MODULES['avm-ptn-alz'];

// Small builders for the rows that repeat in every architecture below. Each one
// returns the same plain object the pages read, with the keys in the same
// order, so the lists stay short enough to scan.

/** One step of the request-flow strip on the detail page. */
const stage = (id, title, subtitle, boundary, guardrail) => ({
  id,
  title,
  subtitle,
  boundary,
  guardrail,
});

/** A clickable marker on the diagram; `[x, y]` is its position in percent. */
const hotspot = (id, [x, y], label, tooltip, description) => ({
  id,
  x,
  y,
  label,
  tooltip,
  description,
});

/** One cloud service and the job it does in this architecture. */
const service = (name, icon, role) => ({ name, icon, role });

/** A billing surprise to watch for, and how to avoid it. */
const costTrap = (service, trap, mitigation) => ({ service, trap, mitigation });

const WAF_PILLARS = ['security', 'reliability', 'performance', 'cost', 'operational'];

/**
 * The Well-Architected score card. `scores` lists the five pillar scores in
 * the order of WAF_PILLARS; `notes` holds a sentence for the pillars that have
 * one, and each of those repeats its pillar's score next to the sentence.
 */
const wafScores = (scores, notes) => {
  const card = Object.fromEntries(WAF_PILLARS.map((pillar, i) => [pillar, scores[i]]));
  card.pillars = Object.fromEntries(
    Object.entries(notes).map(([pillar, text]) => [pillar, { score: card[pillar], notes: text }])
  );
  return card;
};

/** The "Verify in 15-Min Browser Lab" box: what it was checked with, and which lab opens. */
const labCheck = (validatedWith, labSlug) => ({
  validatedWith,
  ctaLabel: 'Verify in 15-Min Browser Lab',
  ctaUrl: `/education/labs/${labSlug}`,
});

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
        stage(
          'users-internet',
          'Users & Internet',
          'HTTPS (TLS 1.2+) client traffic entering over the public edge.',
          'Edge',
          'DNS + TLS 1.2+'
        ),
        stage(
          'app-gateway-waf',
          'Application Gateway + WAF',
          'Layer-7 load balancer running OWASP CRS rules in Prevention mode.',
          'Ingress Subnet',
          'WAF v2 Prevention'
        ),
        stage(
          'web-subnet',
          'Web Tier Subnet',
          'App Service / compute instances isolated behind a dedicated Web NSG.',
          'VNet · Web NSG',
          'Allow 443 from AppGW only'
        ),
        stage(
          'db-subnet',
          'Database Tier Subnet',
          'Dedicated data subnet locked down with a strict Database NSG.',
          'VNet · DB NSG',
          'Allow 1433 from Web Subnet'
        ),
        stage(
          'private-endpoint-sql',
          'Private Endpoint → Azure SQL',
          'Private Link NIC mapped via Private DNS Zone to Azure SQL Database.',
          'Private Link',
          'Public access disabled'
        ),
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
      service(
        'Azure Application Gateway (WAF v2)',
        'shield',
        'Terminates TLS and filters Layer-7 web traffic with OWASP rules before it enters the application tier.'
      ),
      service(
        'Azure Virtual Network & NSGs',
        'hub',
        'Segments ingress, web, and database tiers into isolated subnets with least-privilege network security rules.'
      ),
      service(
        'Azure Private Endpoint',
        'lock',
        'Brings Azure SQL Database onto a private VNet IP address so database traffic never traverses the public internet.'
      ),
      service(
        'Azure SQL Database',
        'database',
        'Managed relational data tier with Entra-only authentication, zone redundancy, and automated backups.'
      ),
      service(
        'Microsoft Entra ID',
        'badge',
        'Provides passwordless Managed Identity authentication between the web tier, Key Vault, and Azure SQL.'
      ),
      service(
        'Azure Key Vault',
        'key',
        'Stores TLS certificates and application secrets behind RBAC and private network controls.'
      ),
      service(
        'Azure Monitor & Log Analytics',
        'monitoring',
        'Centralizes WAF logs, NSG flow telemetry, and SQL audit trails for operational visibility and alerting.'
      ),
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
    waf: wafScores([95, 90, 88, 84, 92], {
      security:
        'WAF v2 at the edge, subnet-level NSGs, Private Link to Azure SQL, and Entra Managed Identities.',
      reliability:
        'Zone-redundant Application Gateway and Azure SQL with automated point-in-time backups.',
      performance: 'Autoscaling web tier and connection pooling over low-latency Private Link.',
      cost: 'Right-sized vCore SQL tier and autoscaled App Gateway v2 capacity units.',
      operational: 'Centralized Log Analytics workspace and full Terraform infrastructure-as-code.',
    }),
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
    landingZonePreset: 'secure-2-tier',
    interactiveLabId: 'terraform-validate-walkthrough',
    whenNotToUse: [
      'Low-budget dev/test sandboxes where Application Gateway v2 and Private Endpoint hourly standing charges exceed compute spend.',
      'Teams without Terraform state management maturity (use App Service with built-in VNet integration first).',
    ],
    finopsCostTraps: [
      costTrap(
        'Application Gateway v2 Capacity Units',
        'Fixed minimum capacity units cost ~$175/mo even with zero web traffic.',
        'Configure autoscale with minimum capacity 0 in non-production environments to avoid baseline billing.'
      ),
      costTrap(
        'Private Endpoints & Cross-Subnet Data Transfer',
        'Data processing charges ($0.01/GB) compound when transferring large SQL backup files or bulk datasets over Private Link.',
        'Keep bulk export traffic within the regional backbone or attach an ACR/Storage Private Endpoint directly to the data subnet.'
      ),
    ],
    ecosystemPartnerValidation: labCheck(
      'HashiCorp Terraform + Azure Verified Modules (AVM)',
      'terraform-validate-walkthrough'
    ),
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
    landingZonePreset: 'enterprise-default',
    interactiveLabId: 'terraform-validate-walkthrough',
    whenNotToUse: [
      'Single-workload prototypes or early-stage startups where hub operational overhead and Azure Firewall hourly costs ($912/mo) dwarf compute value.',
      'Isolated edge deployments with zero cross-region or hybrid on-premises connectivity requirements.',
    ],
    finopsCostTraps: [
      costTrap(
        'Azure Firewall SKU Selection',
        'Standard SKU ($912/mo) and Premium SKU ($1,277/mo) run fixed standing costs regardless of throughput.',
        'Start on Basic Firewall ($288/mo) for environments with 2 or fewer spokes and under 100 Mbps aggregate throughput.'
      ),
      costTrap(
        'Spoke Virtual Network Peering',
        'Bi-directional peering data transfer fees ($0.01/GB in + $0.01/GB out) compound when chatty microservices communicate across spoke boundaries.',
        'Consolidate tightly coupled services into a single multi-subnet spoke to keep traffic on local routing.'
      ),
    ],
    howItWorks: [
      'On-premises and branch traffic terminates in the Connectivity Hub via ExpressRoute or VPN Gateway.',
      'Azure Firewall in the hub inspects east-west traffic between workload spokes and north-south egress.',
      'Spoke virtual networks peer to the hub with useRemoteGateways and user-defined routes forcing 0.0.0.0/0 to the hub firewall.',
      'Azure Private DNS Resolver in the hub resolves Private Link FQDNs across all peered spokes.',
      'Azure Policy assignments at the management group scope enforce allowed regions, NSGs on every subnet, and diagnostic settings.',
    ],
    keyServices: [
      service(
        'Azure Virtual Network & Peering',
        'hub',
        'Connects isolated workload spokes to a shared transit hub without transitive spoke-to-spoke routing.'
      ),
      service(
        'Azure Firewall Premium',
        'security',
        'Provides centralized TLS inspection, IDPS, and FQDN filtering for spoke traffic.'
      ),
      service(
        'Azure Policy',
        'policy',
        'Applies management-group guardrails for tagging, Private Link DNS, and network compliance.'
      ),
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
    terraformCode: `module "alz" {
  source              = "${ALZ_MODULE.source}"
  version             = "${ALZ_MODULE.version}"
  architecture_name   = "alz"
  location            = "eastus2"
  parent_resource_id  = data.azurerm_client_config.current.tenant_id
}`,
    ecosystemPartnerValidation: labCheck(
      'HashiCorp Terraform + Azure Verified Modules (AVM)',
      'terraform-validate-walkthrough'
    ),
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
      service(
        'Azure Migrate',
        'cloud_sync',
        'Discovers on-premises inventory, dependencies, and replicates disks for staged cutovers.'
      ),
      service(
        'Azure Recovery Services',
        'backup',
        'Protects migrated VMs with immutable recovery points and cross-region restore.'
      ),
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
    interactiveLabId: 'landing-zone-builder-output',
    whenNotToUse: [
      'Greenfield cloud-native applications that can be re-architected directly onto container services or serverless platforms without VMware hypervisor dependencies.',
      'Cost-sensitive dev/test environments where the minimum 3-node Azure VMware Solution (AVS) private cloud commitment ($8,000+/mo) exceeds budget.',
    ],
    finopsCostTraps: [
      costTrap(
        'Azure VMware Solution (AVS) Minimum Node Cluster',
        'AVS requires a minimum 3-node cluster commitment per private cloud, running fixed 24/7 billing regardless of VM density or idle capacity.',
        'Maximize VM consolidation ratios, leverage 1-year or 3-year Reserved Instances, and monitor FOCUS 1.4 EffectiveCost to amortize node commitments.'
      ),
      costTrap(
        'ExpressRoute UltraGateway & Dedicated Peering',
        'Over-provisioning ExpressRoute gateway SKUs and dedicated peering circuits incurs high standing hourly charges before migration wave 1 begins.',
        'Start on HighPerformance or Standard ExpressRoute gateways during initial discovery and upgrade dynamically as bulk replication throughput scales.'
      ),
    ],
    tags: ['Migration', 'VMware', 'Right-Sizing', 'Hybrid'],
  },
  'finops-guardrails-azure': {
    title: 'FinOps Guardrails for Azure Subscriptions',
    category: 'FinOps',
    complexity: 'Level 300',
    description:
      'Policy and budget-control pattern with Cost Management exports, Azure Policy enforcement, and automated anomaly alerts.',
    promise:
      'Continuous cost governance across Azure subscriptions using mandatory cost-center tags, scheduled FOCUS 1.4 exports, and anomaly alerts.',
    estimatedCost: '$950 / month',
    howItWorks: [
      'Azure Policy requires environment, owner, and cost-center tags on every resource group at creation time and inherits them onto child resources.',
      'Cost Management exports daily amortized cost and usage data in FOCUS 1.4 format to an Azure Storage account.',
      'Subscription and resource-group budgets evaluate actual and forecasted spend against monthly thresholds.',
      'Automated anomaly detection alerts engineering leads when daily spend deviates from baseline.',
      'Advisor right-sizing and unattached-disk policies flag idle resources for scheduled cleanup.',
    ],
    keyServices: [
      service(
        'Microsoft Cost Management',
        'monitoring',
        'Tracks actual and forecasted spend, reservation utilization, and daily anomaly alerts.'
      ),
      service(
        'Azure Policy',
        'policy',
        'Blocks untagged deployments and restricts expensive VM SKU families in non-production subscriptions.'
      ),
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
      <p>Automated FinOps guardrails combine preventive Azure Policy definitions with daily FOCUS 1.4 cost exports and budget alerting.</p>
    `,
    interactiveLabId: 'terraform-validate-walkthrough',
    whenNotToUse: [
      'Single-subscription exploratory sandboxes or transient hackathons where strict tag-blocking policies and automated shutdown scripts block rapid prototyping.',
      'Organizations without a centralized cloud center of excellence (CCoE) or FinOps practice to review policy exemption requests.',
    ],
    finopsCostTraps: [
      costTrap(
        'Storage Account Cost Export Georedundancy',
        'Exporting raw daily FOCUS 1.4 billing datasets to GRS/GZRS storage accounts triggers unnecessary geo-replication data processing and write operation charges.',
        'Host cost management export containers in LRS storage within the primary region, applying lifecycle policies to transition historical raw exports to Cold/Archive.'
      ),
      costTrap(
        'Log Analytics Audit Telemetry Ingestion',
        'Streaming high-frequency Azure Policy evaluation audits and diagnostic logs across all resource providers causes data ingestion spikes ($2.30/GB).',
        'Set table-level Log Analytics data retention, enable Basic Logs for verbose diagnostic tables, and filter out low-severity policy evaluation events.'
      ),
    ],
    tags: ['FinOps', 'Governance', 'Azure Policy', 'FOCUS 1.4'],
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
      service(
        'Azure Cosmos DB',
        'database',
        'Provides single-digit millisecond global reads and tunable consistency across regions.'
      ),
      service(
        'Azure SQL Auto-Failover Groups',
        'sync_alt',
        'Manages geo-replication and stable read-write / read-only listener endpoints across regions.'
      ),
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
    interactiveLabId: 'terraform-validate-walkthrough',
    whenNotToUse: [
      'Single-region workloads with low concurrency where Azure SQL single database or Azure Cache for Redis provides sufficient throughput at a fraction of the cost.',
      'Purely relational workloads requiring complex multi-table distributed cross-partition ACID transactions across geographic boundaries.',
    ],
    finopsCostTraps: [
      costTrap(
        'Cosmos DB Multi-Region Autoscale RU/s',
        'Configuring autoscale with unpinned maximum Request Units (RU/s) across multiple write regions multiplies baseline charges by the number of active regions ($0.016/hr per 100 RU/s per region).',
        'Cap maximum autoscale RU/s based on 95th-percentile load and track FOCUS 1.4 PricingQuantity and EffectiveCost across regional resources.'
      ),
      costTrap(
        'Azure SQL Cross-Region Auto-Failover Replication Egress',
        'Continuous asynchronous replication of high-churn transactional databases generates high cross-region data transfer egress fees ($0.02/GB).',
        'Tune transaction log commit batching, separate static history from high-churn operational tables, and monitor replication bandwidth.'
      ),
    ],
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
      service(
        'Microsoft Entra Conditional Access',
        'verified_user',
        'Evaluates user, device health, location, and real-time risk on every authentication request.'
      ),
      service(
        'Privileged Identity Management (PIM)',
        'admin_panel_settings',
        'Enforces just-in-time, approval-gated elevation for Azure RBAC and Entra directory roles.'
      ),
      service(
        'Microsoft Defender for Cloud',
        'security',
        'Monitors cloud security posture and detects suspicious identity and resource operations.'
      ),
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
    interactiveLabId: 'terraform-validate-walkthrough',
    whenNotToUse: [
      'Small businesses or early-stage startups without Microsoft Entra ID P2 licensing or dedicated security operations staff to manage PIM workflow approvals.',
      'Static headless machine workloads that cannot support modern OIDC Workload Identity Federation and rely on legacy basic authentication.',
    ],
    finopsCostTraps: [
      costTrap(
        'Microsoft Entra ID P2 & Sentinel Ingestion',
        'Ingesting verbose interactive sign-in, non-interactive service principal, and PIM audit streams into Microsoft Sentinel triggers rapid data ingestion overage costs.',
        'Use Auxiliary Logs or Basic Logs in Log Analytics for raw sign-in telemetry, reserving Analytics tier ingestion for security alert rules.'
      ),
      costTrap(
        'Privileged Identity Management License Sprawl',
        'Assigning Entra P2 licenses to every directory user rather than scoping to active administrators elevates monthly subscription overhead.',
        'Audit active and eligible PIM role assignments quarterly, removing unassigned or orphaned security principals.'
      ),
    ],
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
      service(
        'Azure Event Grid',
        'bolt',
        'Routes reactive pub/sub events with push delivery and declarative filtering.'
      ),
      service(
        'Azure Service Bus',
        'swap_horiz',
        'Provides enterprise message brokering with FIFO sessions, transactions, and dead-letter queues.'
      ),
      service(
        'Azure Functions',
        'functions',
        'Executes event-driven compute handlers that scale on queue depth.'
      ),
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
    interactiveLabId: 'terraform-validate-walkthrough',
    whenNotToUse: [
      'Synchronous low-latency transactional architectures requiring guaranteed sub-10ms request-response SLAs.',
      'Monolithic workloads where simple in-memory queues (e.g. RabbitMQ or Redis pub/sub) satisfy throughput without distributed cloud orchestration overhead.',
    ],
    finopsCostTraps: [
      costTrap(
        'Azure Service Bus Premium Messaging Units',
        'Provisioning Service Bus Premium Messaging Units ($675/mo per MU) for low-throughput dev/test workloads generates high fixed baseline costs.',
        'Use Service Bus Standard tier for non-production environments with burstable loads, reserving Premium exclusively for VNet integration and partition scaling.'
      ),
      costTrap(
        'Event Grid Delivery Retry Storms',
        'Failing downstream subscriber endpoints cause Event Grid to trigger exponential backoff retries (up to 24 hours), multiplying invocation fees and function execution costs.',
        'Configure dead-letter storage accounts with maximum delivery attempts capped at 3, and establish alerting on dead-letter queue metrics.'
      ),
    ],
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
      service(
        'Amazon Route 53',
        'public',
        'Directs users to the lowest-latency healthy region with automated DNS failover.'
      ),
      service(
        'Application Load Balancer (ALB)',
        'hub',
        'Terminates TLS and balances HTTP/HTTPS traffic across multi-AZ compute targets.'
      ),
      service(
        'AWS Global Accelerator',
        'speed',
        'Provides static anycast IPs and routes traffic over the AWS global network.'
      ),
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
    interactiveLabId: 'aws-transit-gateway-walkthrough',
    whenNotToUse: [
      'Regional-only web applications where all end users reside within a single geographic market, making multi-region ingress redundant.',
      'Static frontend applications that can be delivered globally through Amazon CloudFront edge caching without regional ALBs or Global Accelerator.',
    ],
    finopsCostTraps: [
      costTrap(
        'AWS Global Accelerator Fixed & Data Processing Fees',
        'Fixed hourly charges ($0.025/hr per accelerator) plus data transfer fees ($0.015 - $0.035/GB) accrue 24/7 across idle accelerators.',
        'Use Route 53 latency-based routing directly to ALBs for cost-sensitive environments, reserving Global Accelerator for UDP/gaming or non-HTTP protocols.'
      ),
      costTrap(
        'Application Load Balancer LCU Over-Indexing',
        'High-frequency short-lived HTTPS connections without keep-alive trigger excessive Load Balancer Capacity Units (LCU) charges.',
        'Enable HTTP/2 and HTTP keep-alive on client connections to amortize connection setup LCUs over multiple HTTP requests.'
      ),
    ],
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
      service(
        'Amazon Aurora Global Database',
        'database',
        'Replicates database storage across regions with sub-second latency and fast promotion.'
      ),
      service(
        'Amazon S3 Cross-Region Replication',
        'cloud_sync',
        'Automatically replicates objects and KMS-encrypted assets to the DR region.'
      ),
      service(
        'HashiCorp Terraform',
        'code',
        'Maintains parity between primary and standby regional network and compute stacks.'
      ),
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
    interactiveLabId: 'aws-transit-gateway-walkthrough',
    whenNotToUse: [
      'Non-critical internal back-office applications with generous RTO/RPO targets (> 4 hours) where automated nightly snapshot restores suffice.',
      'Workloads with strict data residency regulations prohibiting cross-border or cross-region database replication.',
    ],
    finopsCostTraps: [
      costTrap(
        'Aurora Global Database Replicated Write I/O',
        'Every database write operation in the primary region incurs cross-region replicated write I/O charges ($0.20 per million write requests) to each secondary cluster.',
        'Batch write operations, reduce unindexed noisy churn, and track FOCUS 1.4 UsageQuantity and BilledCost per storage operation.'
      ),
      costTrap(
        'Standby Region Compute Idle Running Costs',
        'Running full-capacity warm standby compute instances in the secondary region doubles monthly compute spend for inactive disaster infrastructure.',
        'Adopt a Pilot Light model with autoscaling groups configured to minimum 0 or 1 instance, scaling out only during DR drills or active failover.'
      ),
    ],
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
      service(
        'Amazon ECS on AWS Fargate',
        'deployed_code',
        'Runs isolated container tasks without provisioning or patching host instances.'
      ),
      service(
        'AWS Cloud Map',
        'hub',
        'Maintains dynamic DNS and health-checked service registry for internal microservices.'
      ),
      service(
        'IAM Roles for Tasks',
        'verified_user',
        'Scopes AWS API permissions to individual container tasks rather than shared nodes.'
      ),
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
    interactiveLabId: 'aws-transit-gateway-walkthrough',
    whenNotToUse: [
      'Simple monolithic applications or single-page static apps where AWS App Runner, Lightsail, or S3/CloudFront provide simpler operations at lower cost.',
      'HPC or GPU-intensive training workloads requiring bare-metal host access or specialized kernel tuning.',
    ],
    finopsCostTraps: [
      costTrap(
        'ECS Fargate vCPU & Memory Right-Sizing',
        'Over-allocating memory and vCPU in task definitions (e.g. 2 vCPU / 4 GB for a 50MB Go binary) compounds across auto-scaled tasks.',
        'Profile actual container memory footprints in CloudWatch Container Insights and configure AWS Compute Optimizer recommendations.'
      ),
      costTrap(
        'NAT Gateway Egress for Container Registry Pulls',
        'Routing large container image pulls through public NAT Gateways incurs $0.045/GB NAT data processing plus regional data transfer fees.',
        'Provision VPC Interface Endpoints for Amazon ECR (ecr.api and ecr.dkr) and Gateway Endpoint for S3 to route image layers privately.'
      ),
    ],
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
      service(
        'Amazon API Gateway',
        'api',
        'Manages routing, JWT authorization, request validation, and rate limiting.'
      ),
      service(
        'AWS Lambda',
        'bolt',
        'Executes stateless request handlers billed per millisecond of compute.'
      ),
      service(
        'Amazon DynamoDB',
        'database',
        'Provides serverless key-value and document storage with on-demand capacity scaling.'
      ),
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
    whenNotToUse: [
      'Low-latency legacy systems requiring persistent TCP connections or connection pooling (use ECS Fargate with RDS Proxy).',
      'Continuous 24/7 high-throughput batch stream processing where sustained Lambda concurrency costs exceed reserved EC2 compute.',
    ],
    finopsCostTraps: [
      costTrap(
        'Amazon API Gateway HTTP vs. REST APIs',
        'REST APIs cost $3.50/million requests plus authorizer execution overhead vs $1.00/million for HTTP APIs.',
        'Adopt HTTP APIs (v2) unless specifically requiring API keys, request validation, or WAF associations.'
      ),
      costTrap(
        'Amazon DynamoDB On-Demand vs. Provisioned Capacity',
        'On-demand mode charges $1.25 per million write request units, which compounds dramatically under predictable sustained workloads.',
        'Switch predictable steady-state tables to Provisioned Capacity with auto-scaling to save up to 70%.'
      ),
    ],
    interactiveLabId: 'aws-transit-gateway-walkthrough',
    ecosystemPartnerValidation: labCheck(
      'AWS Serverless Application Model (SAM) + Terraform AWS Provider',
      'terraform-validate-walkthrough'
    ),
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
      service(
        'Amazon S3',
        'storage',
        'Provides 11 nines of durability for raw and curated columnar datasets.'
      ),
      service(
        'AWS Glue',
        'schema',
        'Maintains the central metadata catalog and runs serverless Spark/Python transformations.'
      ),
      service(
        'Amazon Athena',
        'Troubleshoot',
        'Executes interactive serverless SQL queries directly against partitioned S3 objects.'
      ),
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
    interactiveLabId: 'aws-transit-gateway-walkthrough',
    whenNotToUse: [
      'Transactional OLTP workloads requiring high-concurrency, low-latency row-level mutations (ACID point updates).',
      'Small datasets (< 50 GB) where Amazon RDS PostgreSQL or SQLite in S3 provides simpler querying without Athena or Glue overhead.',
    ],
    finopsCostTraps: [
      costTrap(
        'Amazon Athena Unpartitioned Scan Costs',
        'Running ad-hoc SELECT queries over unpartitioned, uncompressed CSV or JSON data scans entire S3 prefixes at $5.00 per TB scanned.',
        'Convert raw data to compressed columnar Parquet with Snappy or ZSTD, partition by date/region, and enforce per-workgroup query scan limits.'
      ),
      costTrap(
        'S3 PUT/LIST Request Amplification',
        'Ingesting millions of small files (< 128 KB) generates massive S3 API request fees ($0.005 per 1,000 PUTs) and degrades query performance.',
        'Compact streaming micro-batches into 128 MB – 512 MB file chunks before uploading to S3 or run automated compaction jobs.'
      ),
    ],
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
      service(
        'AWS Direct Connect',
        'settings_input_component',
        'Delivers dedicated private fiber connectivity between on-premises routers and AWS.'
      ),
      service(
        'AWS Transit Gateway',
        'hub',
        'Acts as a regional cloud router connecting hundreds of VPCs and hybrid attachments.'
      ),
      service(
        'AWS Site-to-Site VPN',
        'vpn_key',
        'Provides automated encrypted backup routing over BGP when Direct Connect is degraded.'
      ),
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
    interactiveLabId: 'aws-transit-gateway-walkthrough',
    whenNotToUse: [
      'Lightweight branch office connectivity where standard AWS Site-to-Site VPN over the public internet provides adequate throughput (< 1 Gbps).',
      'Cloud-only startups with zero on-premises data centers, private colocation, or mainframe dependencies.',
    ],
    finopsCostTraps: [
      costTrap(
        'AWS Direct Connect Dedicated Port Standing Charges',
        'Dedicated 1 Gbps ($0.30/hr) and 10 Gbps ($2.25/hr) Direct Connect ports bill continuously whether active traffic is flowing or not.',
        'Start with Hosted Connections from an AWS Direct Connect Partner for sub-1 Gbps speeds, scaling to dedicated ports only when utilization justifies it.'
      ),
      costTrap(
        'AWS Transit Gateway Attachment & Processing Fees',
        'Each VPC attachment incurs a flat hourly charge ($0.05/hr) plus data processing ($0.02/GB), which multiplies across multi-VPC spoke architectures.',
        'Consolidate workload subnets into shared VPCs where appropriate and bypass Transit Gateway for high-volume intra-region traffic using VPC peering.'
      ),
    ],
    tags: ['Networking', 'Hybrid Cloud', 'Enterprise'],
  },
};

export const gcpArchitectures = {
  'global-load-balancing': {
    title: 'Global Load Balancing',
    category: 'Compute & Networking',
    complexity: 'Production',
    description:
      'Global external HTTP(S) load balancing with Cloud Armor, regional failover policies, and CDN edge caching for resilient web workloads.',
    promise:
      'Global anycast IP routing, sub-second regional failover, and Cloud Armor edge security across distributed Cloud Run and GCE workloads.',
    estimatedCost: '$1,800 - $2,800 / month',
    topology: {
      caption:
        'Anycast ingress through Google Front End and Cloud Armor to regional backend services',
      surrounding: ['Cloud DNS', 'Cloud Armor', 'Cloud Monitoring', 'VPC Network'],
      stages: [
        stage(
          'users-anycast',
          'Global Clients & Anycast IP',
          'Traffic terminates at the nearest Google edge PoP over single anycast VIP.',
          'Edge PoP',
          'TLS 1.3 + HTTP/2'
        ),
        stage(
          'cloud-armor',
          'Cloud Armor Security Policy',
          'Layer-7 filtering against OWASP Top 10 with adaptive rate limiting.',
          'Edge Defense',
          'WAF Prevention'
        ),
        stage(
          'gfe-url-map',
          'URL Map & SSL Proxy',
          'Content-based routing directing traffic to nearest healthy backend region.',
          'Google Front End',
          'Region Affinity'
        ),
        stage(
          'backend-services',
          'Multi-Region Backend Services',
          'Regional managed instance groups and serverless network endpoint groups.',
          'Region Primary & Secondary',
          'Capacity Health Checks'
        ),
        stage(
          'cloud-cdn',
          'Cloud CDN Cache Fill',
          'Edge caching for static assets with signed URL validation for private media.',
          'Edge Cache',
          'Origin Shield'
        ),
      ],
    },
    hotspots: [
      hotspot(
        'spot-armor',
        [25, 35],
        'Cloud Armor',
        'Edge DDoS & WAF Rules',
        'Filters malicious requests before they hit backend capacity.'
      ),
      hotspot(
        'spot-urlmap',
        [50, 50],
        'Global Forwarding',
        'Anycast URL Map',
        'Directs clients to lowest-latency regional backends.'
      ),
      hotspot(
        'spot-backends',
        [75, 65],
        'Backend Services',
        'Autoscaling Compute',
        'Regional instance groups scaling dynamically on CPU load.'
      ),
    ],
    services: [
      service(
        'Global External Application Load Balancer',
        'hub',
        'Distributes HTTP(S) traffic across multiple cloud regions using Google global network.'
      ),
      service(
        'Google Cloud Armor',
        'shield',
        'Provides enterprise DDoS protection, IP allowlisting, and OWASP rule inspection.'
      ),
      service(
        'Cloud CDN',
        'cached',
        'Caches static and dynamic content at Google points of presence globally.'
      ),
      service(
        'Compute Engine MIGs',
        'dns',
        'Autoscaling regional managed instance groups running containerized application tiers.'
      ),
    ],
    practices: [
      'Attach Cloud Armor security policies with calibrated rate limiting to all global forwarding rules.',
      'Configure multi-region backend services with consistent health check timeouts under 5 seconds.',
      'Enforce modern TLS profile requiring TLS 1.2+ with restricted cipher suites.',
    ],
    outcome: [
      'Enables resilient multi-region application delivery with sub-second failover and automatic DDoS mitigation.',
    ],
    overview: `
      <h2>Architecture Overview</h2>
      <p>This reference architecture leverages Google Cloud Global External Application Load Balancer with Cloud Armor to deliver resilient, high-performance web applications across multiple regions.</p>
      <h3>Core Components</h3>
      <ul>
        <li><strong>Global Forwarding Rule:</strong> Single anycast IP address advertising via BGP worldwide.</li>
        <li><strong>Cloud Armor Policy:</strong> Evaluates incoming requests at the Google edge against OWASP CRS rulesets.</li>
        <li><strong>Regional Backend Services:</strong> Balances requests across independent regional compute pools based on capacity and proximity.</li>
      </ul>
    `,
    waf: wafScores([96, 95, 97, 88, 92], {
      security: 'Cloud Armor WAF rules, managed SSL certificates, and private backend VPC peering.',
    }),
    terraformCode: `resource "google_compute_global_forwarding_rule" "default" {
  name       = "global-alb-rule"
  target     = google_compute_target_https_proxy.default.id
  port_range = "443"
  ip_address = google_compute_global_address.default.address
}`,
    whenNotToUse: [
      'Internal microservices and regional backends that do not accept public edge ingress or multi-region failover.',
      'Static websites that can be served directly from Cloud Storage and Cloud CDN without dynamic backend services.',
    ],
    finopsCostTraps: [
      costTrap(
        'Cloud Armor Security Policies',
        'Base policy costs $5/mo plus $1 per rule, but request evaluation fees ($0.75 per million requests) compound under high-traffic endpoints.',
        'Combine multiple IP ranges into named IP lists to minimize active rule counts and evaluation hops.'
      ),
      costTrap(
        'Inter-Region Backend Data Egress',
        'Routing user requests from a US edge PoP to an EU backend triggers premium cross-region network egress ($0.08 - $0.12/GB).',
        'Deploy identical backend instance groups in all primary operating regions and configure region-affinity routing.'
      ),
    ],
    interactiveLabId: 'gcp-shared-vpc-walkthrough',
    ecosystemPartnerValidation: labCheck(
      'Google Cloud Foundation Fabric + Terraform Google Provider',
      'terraform-validate-walkthrough'
    ),
    tags: ['Networking', 'Security', 'Global', 'Compute'],
  },
  'bigquery-data-lake': {
    title: 'BigQuery Data Lake',
    category: 'Data & Analytics',
    complexity: 'Production',
    description:
      'Unified analytics architecture combining BigQuery, Dataplex, and Cloud Storage lifecycle controls for governed enterprise reporting.',
    promise:
      'Serverless petabyte-scale data analytics with Dataplex policy guardrails, automated data lifecycle transitions, and column-level encryption.',
    estimatedCost: '$1,800 - $2,600 / month',
    topology: {
      caption: 'Data lake ingestion, transformation, and governed consumption architecture',
      surrounding: ['Dataplex Catalog', 'Cloud KMS', 'Cloud IAM', 'VPC Service Controls'],
      stages: [
        stage(
          'ingest-gcs',
          'Cloud Storage Raw Lake',
          'Multi-zone raw data buckets with lifecycle transitions to nearline storage.',
          'Landing Zone',
          'Object Versioning'
        ),
        stage(
          'dataplex-discovery',
          'Dataplex Lake Governance',
          'Automated schema discovery, data quality profiling, and policy tags.',
          'Governance Mesh',
          'Policy Tag RBAC'
        ),
        stage(
          'bigquery-warehouse',
          'BigQuery Unified Warehouse',
          'Partitioned and clustered analytical datasets with customer-managed keys.',
          'Analytics Engine',
          'Column-Level Encryption'
        ),
        stage(
          'consumption-bi',
          'Enterprise BI & Looker',
          'Governed semantic layer connecting business analysts to curated views.',
          'Consumption Tier',
          'Authorized Views'
        ),
      ],
    },
    hotspots: [
      hotspot(
        'spot-gcs',
        [20, 40],
        'Raw Storage',
        'Cloud Storage Bucket',
        'Landing bucket with object lifecycle rules and KMS encryption.'
      ),
      hotspot(
        'spot-dataplex',
        [50, 50],
        'Dataplex Mesh',
        'Governance Zone',
        'Discovers schemas and enforces data classification policies.'
      ),
      hotspot(
        'spot-bq',
        [80, 60],
        'BigQuery Core',
        'Serverless SQL',
        'Optimized partitioned storage for fast SQL queries.'
      ),
    ],
    services: [
      service(
        'BigQuery',
        'storage',
        'Serverless enterprise data warehouse supporting petabyte-scale SQL queries.'
      ),
      service(
        'Google Cloud Storage',
        'folder',
        'Durable object storage foundation for structured and unstructured data assets.'
      ),
      service(
        'Dataplex',
        'analytics',
        'Unified data fabric for centralized data discovery, governance, and quality metrics.'
      ),
      service(
        'Cloud KMS',
        'vpn_key',
        'Provides customer-managed encryption keys for stored data assets.'
      ),
    ],
    practices: [
      'Partition BigQuery tables on ingestion date or timestamp and cluster by high-cardinality query keys.',
      'Enforce column-level access controls using Dataplex policy tags for sensitive PII data.',
      'Apply automated Cloud Storage lifecycle rules transitioning raw data to Coldline after 90 days.',
    ],
    outcome: [
      'Delivers a governed, secure analytics platform with automated data cataloging and sub-second query performance.',
    ],
    overview: `
      <h2>Architecture Overview</h2>
      <p>This reference design establishes a modern enterprise data lakehouse combining Cloud Storage object storage with BigQuery analytics and Dataplex governance.</p>
    `,
    waf: wafScores([94, 95, 96, 90, 93], {
      security: 'Column-level security tags, customer-managed keys, and private network perimeter.',
    }),
    terraformCode: `resource "google_bigquery_dataset" "analytics" {
  dataset_id                  = "enterprise_lake"
  friendly_name               = "Governed Data Lake"
  location                    = "US"
  default_table_expiration_ms = 7776000000
}`,
    interactiveLabId: 'gcp-shared-vpc-walkthrough',
    whenNotToUse: [
      'Operational databases requiring single-millisecond row lookups and high-frequency OLTP inserts (use Cloud Spanner or Cloud SQL).',
      'Projects with minimal data (< 10 GB) where BigQuery on-demand minimum scans and pipeline infrastructure add unnecessary complexity.',
    ],
    finopsCostTraps: [
      costTrap(
        'BigQuery On-Demand Query Data Scanning',
        'Running unpartitioned and unclustered SELECT * queries against multi-terabyte tables bills at $6.25 per TB scanned, draining budgets quickly.',
        'Require partition and cluster filters on large tables, enforce maximum bytes billed limits in query jobs, and monitor FOCUS 1.4 EffectiveCost.'
      ),
      costTrap(
        'Cloud Storage Dual-Region / Multi-Region Replication',
        'Storing massive raw staging data in Multi-Region or Dual-Region buckets doubles storage unit costs and cross-region network charges.',
        'Store raw staging layers in Single-Region buckets, applying object lifecycle rules to transition data to Coldline after 30 days.'
      ),
    ],
    tags: ['Data', 'Analytics', 'Governance', 'BigQuery'],
  },
  'hybrid-interconnect': {
    title: 'Hybrid Interconnect',
    category: 'Networking',
    complexity: 'Mission Critical',
    description:
      'Low-latency private connectivity pattern using Dedicated Interconnect, Cloud Router, and HA VPN fallback for critical hybrid systems.',
    promise:
      '99.99% carrier-grade SLA with automated BGP failover between Dedicated Interconnect circuits and HA VPN backup tunnels.',
    estimatedCost: '$3,200 - $4,800 / month',
    topology: {
      caption: 'Hybrid on-premises to Google Cloud routing topology with BGP multi-pathing',
      surrounding: ['Cloud Router', 'Dedicated Interconnect', 'HA Cloud VPN', 'Cloud Monitoring'],
      stages: [
        stage(
          'onprem-dc',
          'Customer Data Center',
          'Dual redundant edge routers terminating 10 Gbps cross-connect circuits.',
          'On-Premises',
          'BGP Active-Active'
        ),
        stage(
          'colocation-meet',
          'Interconnect Co-location Facility',
          'Diverse physical fiber cross-connects at independent metro facilities.',
          'Partner PoP',
          'Physical Diversity'
        ),
        stage(
          'cloud-router',
          'Cloud Router & VLAN Attachments',
          'Dynamic route exchange with Multi-Exit Discriminator metric controls.',
          'Google Network',
          'BGP Keepalives'
        ),
        stage(
          'ha-vpn-backup',
          'HA Cloud VPN Fallback',
          'Automated IPsec encrypted backup path when physical circuits degrade.',
          'Internet Transport',
          'IKEv2 Encryption'
        ),
        stage(
          'shared-vpc',
          'Shared VPC Host Network',
          'Central hub network distributing connectivity across spoke projects.',
          'Platform Network',
          'Private Google Access'
        ),
      ],
    },
    hotspots: [
      hotspot(
        'spot-interconnect',
        [25, 40],
        'Dedicated Interconnect',
        '10 Gbps VLAN Attachments',
        'Primary high-bandwidth fiber connection to Google network.'
      ),
      hotspot(
        'spot-router',
        [55, 50],
        'Cloud Router',
        'BGP Peering Engine',
        'Handles dynamic route advertisement and metric failover.'
      ),
      hotspot(
        'spot-vpn',
        [80, 65],
        'HA VPN Standby',
        'Encrypted Fallback',
        'Standby IPsec tunnels ready for seamless failover.'
      ),
    ],
    services: [
      service(
        'Dedicated Interconnect',
        'settings_ethernet',
        'Provides direct physical fiber cross-connects between on-premises and Google networks.'
      ),
      service(
        'Cloud Router',
        'router',
        'Exchanges routes between enterprise on-premises networks and Google VPCs via BGP.'
      ),
      service(
        'HA Cloud VPN',
        'vpn_lock',
        'Delivers 99.99% SLA encrypted backup IPsec tunnels over standard public connectivity.'
      ),
      service(
        'Shared VPC',
        'hub',
        'Centralizes network administration and connects workloads across multiple service projects.'
      ),
    ],
    practices: [
      'Provision two Dedicated Interconnect circuits across distinct metropolitan colocation facilities.',
      'Configure Cloud Router BGP keepalive intervals and advertise summary routes only.',
      'Deploy HA Cloud VPN with automated failover testing to maintain 99.99% availability.',
    ],
    outcome: [
      'Ensures uninterrupted hybrid cloud communication with automated BGP failover and sub-millisecond network jitter.',
    ],
    overview: `
      <h2>Architecture Overview</h2>
      <p>This mission-critical networking pattern connects corporate data centers to Google Cloud using redundant Dedicated Interconnect circuits backed by high-availability IPsec tunnels.</p>
    `,
    waf: wafScores([98, 99, 98, 86, 95], {
      reliability: 'Dual-circuit physical diversity with automated BGP failover to HA VPN.',
    }),
    terraformCode: `resource "google_compute_router" "hybrid_router" {
  name    = "cr-hybrid-hub"
  network = "shared-vpc"
  bgp {
    asn = 64514
  }
}`,
    interactiveLabId: 'gcp-shared-vpc-walkthrough',
    whenNotToUse: [
      'Development and staging environments where Cloud VPN (IPsec) provides sufficient bandwidth (< 3 Gbps) at a fraction of the cost.',
      'Cloud-native greenfield environments without on-premises data centers or regulatory requirements for private physical links.',
    ],
    finopsCostTraps: [
      costTrap(
        'Dedicated Interconnect 10Gbps Link Standing Fees',
        'Each 10 Gbps Dedicated Interconnect circuit carries a fixed fee of $1,750/month per port regardless of actual network utilization.',
        'Evaluate Partner Interconnect with sub-gigabit VLAN attachments (50 Mbps – 1 Gbps) before committing to 10 Gbps physical circuits.'
      ),
      costTrap(
        'Inter-Region Shared VPC Egress Egress',
        'Routing data from a European on-premises interconnect into US-based workload subnets triggers premium international backbone egress ($0.08 - $0.12/GB).',
        'Terminate interconnect circuits in the nearest geographic Google Cloud region and keep workload compute collocated with data storage.'
      ),
    ],
    tags: ['Networking', 'Hybrid Cloud', 'Interconnect', 'Enterprise'],
  },
  'vertex-ai-pipeline': {
    title: 'Vertex AI Pipeline',
    category: 'AI/ML',
    complexity: 'Production',
    description:
      'End-to-end MLOps blueprint with Vertex AI Pipelines, Feature Store, and model registry promotion across dev/stage/prod projects.',
    promise:
      'Reproducible Kubeflow-based machine learning pipelines with unified feature serving and automated CI/CD artifact registration.',
    estimatedCost: '$2,000 - $3,000 / month',
    topology: {
      caption: 'Vertex AI MLOps lifecycle from data ingestion to governed model deployment',
      surrounding: ['Vertex Model Registry', 'Artifact Registry', 'Cloud Storage', 'Cloud IAM'],
      stages: [
        stage(
          'data-feature',
          'Feature Store & Extraction',
          'Centralized feature registry ensuring training-serving feature consistency.',
          'Feature Store',
          'Point-in-Time Joins'
        ),
        stage(
          'pipeline-orch',
          'Vertex AI Pipelines',
          'Serverless workflow execution running orchestrated data validation and training steps.',
          'Workflow Engine',
          'Artifact Lineage'
        ),
        stage(
          'model-eval',
          'Automated Evaluation & Registry',
          'Performance metric gating and model registration with version lineage.',
          'Model Registry',
          'Approval Gates'
        ),
        stage(
          'endpoint-deploy',
          'Managed Prediction Endpoint',
          'Private endpoint deployment with autoscaling compute and continuous skew detection.',
          'Serving Cluster',
          'Model Monitoring'
        ),
      ],
    },
    hotspots: [
      hotspot(
        'spot-pipeline',
        [30, 45],
        'Pipeline Engine',
        'Serverless Workflows',
        'Executes repeatable training steps with complete artifact lineage.'
      ),
      hotspot(
        'spot-registry',
        [60, 55],
        'Model Registry',
        'Governed Models',
        'Tracks model versioning, evaluations, and compliance approvals.'
      ),
      hotspot(
        'spot-serving',
        [85, 65],
        'Prediction Endpoint',
        'Autoscaling Serving',
        'Low-latency private inference endpoints with drift monitoring.'
      ),
    ],
    services: [
      service(
        'Vertex AI Pipelines',
        'account_tree',
        'Orchestrates machine learning training and evaluation workflows using Kubeflow components.'
      ),
      service(
        'Vertex AI Model Registry',
        'inventory_2',
        'Centralizes model lifecycle management, version tracking, and deployment promotion.'
      ),
      service(
        'Vertex AI Feature Store',
        'dataset',
        'Serves online and offline feature representations with point-in-time correctness.'
      ),
      service(
        'Cloud Artifact Registry',
        'layers',
        'Houses custom container images and execution packages with vulnerability scanning.'
      ),
    ],
    practices: [
      'Log all pipeline runs with execution metadata and dataset snapshots for full auditability.',
      'Enforce continuous model monitoring on production endpoints to detect data and concept drift.',
      'Run training workloads in isolated VPC networks with private Google access enabled.',
    ],
    outcome: [
      'Accelerates reliable model production releases with end-to-end traceability and automated quality gating.',
    ],
    overview: `
      <h2>Architecture Overview</h2>
      <p>This MLOps blueprint provides a scalable, repeatable foundation for building, evaluating, and deploying machine learning models on Google Cloud Vertex AI.</p>
    `,
    waf: wafScores([92, 94, 95, 89, 93], {
      operational:
        'Automated lineage tracking, reproducible pipeline graphs, and model drift alerts.',
    }),
    terraformCode: `resource "google_vertex_ai_endpoint" "prod_endpoint" {
  name         = "production-prediction-endpoint"
  display_name = "Production Prediction Endpoint"
  location     = "us-central1"
}`,
    interactiveLabId: 'gcp-shared-vpc-walkthrough',
    whenNotToUse: [
      'Simple deterministic batch cron jobs or scikit-learn models that can be packaged in a Cloud Run container or Cloud Functions.',
      'Exploratory data science research where rapid interactive notebooks are needed rather than strict Kubeflow pipeline orchestration.',
    ],
    finopsCostTraps: [
      costTrap(
        'Vertex AI Persistent Prediction Endpoints',
        'Deploying custom prediction routines onto persistent dedicated GPU instances (e.g. NVIDIA A100/L4) runs 24/7 billing even with zero query traffic.',
        'Enable automated minimum replica scaling to 0 on non-production endpoints or deploy lightweight inference onto Cloud Run with GPU support.'
      ),
      costTrap(
        'Feature Store Online Serving Node Provisioning',
        'Maintaining oversized fixed online serving nodes in Vertex AI Feature Store incurs substantial hourly baseline charges.',
        'Use BigQuery-backed Feature Store with Bigtable cache and scale online serving capacity based on query QPS.'
      ),
    ],
    tags: ['AI/ML', 'MLOps', 'Vertex AI', 'Pipelines'],
  },
  'zero-trust-security': {
    title: 'Zero Trust Security',
    category: 'Security',
    complexity: 'Mission Critical',
    description:
      'Identity-aware proxy and BeyondCorp Enterprise architecture enforcing context-aware access and workload isolation across environments.',
    promise:
      'Zero-VPN employee and contractor access enforced by context-aware device health signals, IAM conditions, and VPC Service Controls.',
    estimatedCost: '$2,400 - $3,400 / month',
    topology: {
      caption: 'BeyondCorp context-aware perimeter and zero-trust workload access',
      surrounding: [
        'BeyondCorp Enterprise',
        'Cloud Identity',
        'VPC Service Controls',
        'Security Command Center',
      ],
      stages: [
        stage(
          'client-context',
          'Context-Aware Device Ingress',
          'Endpoint health signals, OS patch status, and geographic geolocation checks.',
          'Endpoint Device',
          'Device Certificate'
        ),
        stage(
          'iap-perimeter',
          'Identity-Aware Proxy (IAP)',
          'Central reverse proxy verifying user identity and access levels per request.',
          'Access Gateway',
          'Context-Aware Policy'
        ),
        stage(
          'vpc-controls',
          'VPC Service Controls Perimeter',
          'Network perimeter preventing unauthorized data exfiltration across services.',
          'Security Perimeter',
          'Exfiltration Prevention'
        ),
        stage(
          'protected-workload',
          'Isolated Enterprise Workloads',
          'Internal compute services operating without public IP addresses or jump boxes.',
          'Private Spoke VPC',
          'Private Service Connect'
        ),
      ],
    },
    hotspots: [
      hotspot(
        'spot-iap',
        [25, 40],
        'Identity Proxy',
        'Identity-Aware Proxy',
        'Authenticates and authorizes requests before reaching backend VPCs.'
      ),
      hotspot(
        'spot-perimeter',
        [55, 55],
        'Service Perimeter',
        'VPC Service Controls',
        'Locks down APIs and storage buckets against exfiltration.'
      ),
      hotspot(
        'spot-workload',
        [80, 65],
        'Private Services',
        'Internal Workload',
        'Workload isolated in private subnets accessible only via IAP.'
      ),
    ],
    services: [
      service(
        'Identity-Aware Proxy',
        'verified_user',
        'Controls access to web applications and VMs running on Google Cloud without VPNs.'
      ),
      service(
        'VPC Service Controls',
        'security',
        'Establishes cryptographic perimeters around Google Cloud resources to prevent exfiltration.'
      ),
      service(
        'BeyondCorp Enterprise',
        'lock',
        'Enforces real-time context-aware access policies combining user identity and device posture.'
      ),
      service(
        'Security Command Center',
        'policy',
        'Provides threat detection, vulnerability scanning, and compliance tracking.'
      ),
    ],
    practices: [
      'Require multi-factor authentication and managed device certificates for all internal resources.',
      'Enforce VPC Service Controls perimeters encompassing BigQuery, Cloud Storage, and Compute APIs.',
      'Audit access logs continuously through Security Command Center with automated alert routing.',
    ],
    outcome: [
      'Eliminates legacy corporate VPN overhead while enforcing granular, real-time context-aware security policies.',
    ],
    overview: `
      <h2>Architecture Overview</h2>
      <p>This BeyondCorp zero-trust reference architecture enables secure, context-aware access to corporate applications without traditional VPN concentrators or jump hosts.</p>
    `,
    waf: wafScores([99, 96, 94, 91, 96], {
      security: 'Context-aware device verification, IAP gateway, and strict VPC Service Controls.',
    }),
    terraformCode: `resource "google_iap_web_type_app_engine" "iap_app" {
  app_id = "default"
  role   = "roles/iap.httpsResourceAccessor"
  member = "group:internal-engineers@example.com"
}`,
    interactiveLabId: 'gcp-shared-vpc-walkthrough',
    whenNotToUse: [
      'Public consumer-facing web applications where users authenticate via social logins rather than corporate enterprise identity providers.',
      'Organizations without Google Workspace or Cloud Identity Premium to manage centralized device context and endpoint verification.',
    ],
    finopsCostTraps: [
      costTrap(
        'BeyondCorp Enterprise Per-User Licensing',
        'Enabling BeyondCorp Enterprise licenses ($6/user/month) across all directory identities rather than active workforce users inflates recurring SaaS spend.',
        'Scope BeyondCorp Enterprise licensing strictly to operational and technical roles requiring context-aware access to sensitive perimeters.'
      ),
      costTrap(
        'VPC Service Controls Troubleshooting Ingestion',
        'Enabling verbose dry-run audit logging across all enterprise services floods Cloud Logging with petabytes of non-rejection log events.',
        'Apply targeted log exclusion filters in Cloud Logging to capture only high-priority violation events during perimeter onboarding.'
      ),
    ],
    tags: ['Security', 'Zero Trust', 'BeyondCorp', 'Identity'],
  },
  'cloud-run-microservices': {
    title: 'Cloud Run Microservices',
    category: 'Serverless',
    complexity: 'Production',
    description:
      'Containerized microservices pattern using Cloud Run, Eventarc, and Pub/Sub with autoscaling and per-service least-privilege IAM.',
    promise:
      'Scale-to-zero serverless microservices with sub-second cold starts, decoupled Eventarc events, and end-to-end TLS encryption.',
    estimatedCost: '$1,000 - $1,800 / month',
    topology: {
      caption: 'Event-driven serverless microservices with Pub/Sub message broker and Cloud Run',
      surrounding: ['Eventarc', 'Cloud Pub/Sub', 'Cloud Tasks', 'Cloud Trace'],
      stages: [
        stage(
          'ingress-run',
          'Public Gateway Service',
          'Stateless frontend API container auto-scaling from zero on demand.',
          'API Ingress',
          'mTLS & IAM Tokens'
        ),
        stage(
          'pubsub-broker',
          'Cloud Pub/Sub Messaging',
          'High-throughput asynchronous message broker with dead-letter queueing.',
          'Event Backbone',
          'At-Least-Once Delivery'
        ),
        stage(
          'eventarc-triggers',
          'Eventarc Event Router',
          'Standardized CloudEvents routing triggers dispatching to worker microservices.',
          'Event Routing',
          'CloudEvents v1.0'
        ),
        stage(
          'worker-services',
          'Internal Processing Services',
          'Private worker containers executing business logic isolated in private VPC.',
          'Internal Microservices',
          'Internal Ingress Only'
        ),
      ],
    },
    hotspots: [
      hotspot(
        'spot-ingress',
        [20, 40],
        'Cloud Run API',
        'Serverless API',
        'Handles ingress HTTP traffic with fast cold-start performance.'
      ),
      hotspot(
        'spot-pubsub',
        [50, 55],
        'Pub/Sub Broker',
        'Message Queue',
        'Decouples service communication with persistent delivery guarantees.'
      ),
      hotspot(
        'spot-workers',
        [80, 65],
        'Cloud Run Workers',
        'Private Workers',
        'Scales horizontally on backlog queue depth without idle compute cost.'
      ),
    ],
    services: [
      service(
        'Google Cloud Run',
        'cloud',
        'Runs stateless containerized microservices that scale down to zero when idle.'
      ),
      service(
        'Cloud Pub/Sub',
        'send',
        'Decouples microservices through scalable asynchronous event ingestion and delivery.'
      ),
      service(
        'Eventarc',
        'bolt',
        'Routes events from Cloud Storage, BigQuery, and custom apps in standard CloudEvents format.'
      ),
      service(
        'Cloud Monitoring & Trace',
        'insights',
        'Provides distributed request tracing and latency waterfall analysis across services.'
      ),
    ],
    practices: [
      'Configure internal microservices with internal ingress to prevent public internet access.',
      'Attach dead-letter topics and retry policies to every Pub/Sub subscription.',
      'Leverage Serverless VPC Access connectors to securely query private databases.',
    ],
    outcome: [
      'Provides a highly elastic, cost-efficient microservices architecture with zero idle compute infrastructure.',
    ],
    overview: `
      <h2>Architecture Overview</h2>
      <p>This event-driven microservices pattern couples Google Cloud Run container execution with Cloud Pub/Sub and Eventarc routing for scalable, decoupled services.</p>
    `,
    waf: wafScores([95, 96, 94, 97, 94], {
      cost: 'Scale-to-zero compute with no standing server costs during quiet hours.',
    }),
    terraformCode: `resource "google_cloud_run_v2_service" "api_service" {
  name     = "orders-api"
  location = "us-central1"
  template {
    containers {
      image = "us-docker.pkg.dev/project/repo/orders-api:v1.0"
    }
  }
}`,
    interactiveLabId: 'gcp-shared-vpc-walkthrough',
    whenNotToUse: [
      'Long-running stateful daemon processes (e.g. streaming workers, background batch pollers) that exceed Cloud Run timeout limits (60 minutes).',
      'Workloads requiring persistent local filesystem state or specialized custom network kernel drivers.',
    ],
    finopsCostTraps: [
      costTrap(
        'Always-On CPU Allocation vs. Request-Based',
        'Configuring "CPU always allocated" on low-traffic services causes Cloud Run to charge continuous baseline vCPU/memory fees ($30+/mo per instance).',
        'Keep "CPU allocated during request processing" enabled for standard APIs, allowing instances to scale to zero when idle.'
      ),
      costTrap(
        'Uncapped Maximum Instance Scaling',
        'Uncapped max-instances on public endpoints exposes services to traffic spikes or DDoS attempts that scale hundreds of containers simultaneously.',
        'Set explicit max-instances guardrails on every Cloud Run service and associate Google Cloud Armor security policies at the ingress load balancer.'
      ),
    ],
    tags: ['Serverless', 'Containers', 'Microservices', 'Event-Driven'],
  },
};

export const finopsArchitectures = {
  'multi-cloud-cost-optimization': {
    title: 'Multi-Cloud Cost Optimization',
    category: 'Cost Analysis',
    complexity: 'Production',
    description:
      'Cross-cloud optimization architecture with shared tagging taxonomy, cost telemetry normalization, and rightsizing recommendation pipelines.',
    promise:
      'Normalized FOCUS 1.4 cost datasets uniting Azure, AWS, and GCP billing exports with automated rightsizing recommendation feeds.',
    estimatedCost: '$1,400 - $2,200 / month',
    topology: {
      caption: 'Multi-cloud cost ingestion, FOCUS normalization, and optimization engine',
      surrounding: [
        'FinOps Open Cost Specification',
        'BigQuery Warehousing',
        'Tagging Policy',
        'Automated Recommendations',
      ],
      stages: [
        stage(
          'cloud-exports',
          'Cloud Billing Exports',
          'Daily automated billing feeds from AWS Cost and Usage, Azure Cost Details, and GCP Billing.',
          'Multi-Cloud Ingestion',
          'Automated Daily Pulls'
        ),
        stage(
          'normalization-engine',
          'FOCUS 1.4 Normalization',
          'Transforms heterogeneous provider billing rows into standardized cost schemas.',
          'Data Transformation',
          'Schema Validation'
        ),
        stage(
          'unified-lake',
          'Unified FinOps Lakehouse',
          'Central repository for multi-cloud queries, commitment tracking, and amortized models.',
          'Cost Repository',
          'Query Cost Controls'
        ),
        stage(
          'actionable-recommendations',
          'Optimization Recommendation Engine',
          'Generates cross-cloud rightsizing, idle resource pruning, and purchase commitments.',
          'Action Engine',
          'Policy Thresholds'
        ),
      ],
    },
    hotspots: [
      hotspot(
        'spot-exports',
        [25, 40],
        'Provider Exports',
        'Billing Data Ingestion',
        'Collects raw billing exports from AWS, Azure, and GCP.'
      ),
      hotspot(
        'spot-focus',
        [55, 50],
        'FOCUS Normalizer',
        'Schema Standardizer',
        'Converts billing lines to unified FOCUS 1.4 cost definitions.'
      ),
      hotspot(
        'spot-recommend',
        [80, 65],
        'Rightsizing Feed',
        'Optimization Engine',
        'Flags unallocated resources and rightsizing candidates.'
      ),
    ],
    services: [
      service(
        'BigQuery Cost Warehouse',
        'storage',
        'Centralizes transformed multi-cloud billing datasets for ad-hoc SQL analysis.'
      ),
      service(
        'Cloud Storage Ingestion',
        'folder_open',
        'Stages raw provider cost detail archives securely across cloud boundaries.'
      ),
      service(
        'FinOps Policy Controller',
        'rule',
        'Validates tag compliance and allocates shared platform expenses.'
      ),
      service(
        'Looker Studio / Grafana',
        'analytics',
        'Renders executive cost dashboards and department-level spend reports.'
      ),
    ],
    practices: [
      'Adopt the FOCUS 1.4 specification for cross-cloud billing field naming and amortized cost models.',
      'Enforce required organizational tags: CostCenter, Environment, Owner, and Application.',
      'Schedule automated rightsizing audits weekly to prevent idle resource sprawl.',
    ],
    outcome: [
      'Delivers unified cross-cloud spend transparency with measurable monthly cloud waste reduction.',
    ],
    overview: `
      <h2>Architecture Overview</h2>
      <p>This FinOps architecture provides a centralized, normalized cost optimization engine that correlates billing data across Azure, AWS, and Google Cloud using the FinOps Open Cost and Usage Specification (FOCUS 1.4).</p>
    `,
    waf: wafScores([92, 94, 93, 98, 94], {
      cost: 'Identifies unattached volumes, idle load balancers, and rightsizing opportunities.',
    }),
    terraformCode: `resource "google_bigquery_table" "finops_focus" {
  dataset_id = "finops_repository"
  table_id   = "focus_v1_4_costs"
  time_partitioning {
    type  = "DAY"
    field = "ChargePeriodStart"
  }
}`,
    whenNotToUse: [
      'Single-cloud estates with total cloud spend under $10,000/month where custom FOCUS 1.4 ETL pipelines cost more than native cost tools.',
      'Teams without enforced organizational tagging policies (raw untagged billing records cannot be allocated by business unit).',
    ],
    finopsCostTraps: [
      costTrap(
        'BigQuery Billing Export Query Scans',
        'Running SELECT * over unpartitioned multi-year billing tables costs $6.25 per TB scanned.',
        'Partition billing tables by export_time (DAY) and cluster by provider, service_id, and cost_center.'
      ),
      costTrap(
        'Automated Rightsizing Idle Timeouts',
        'Downsizing compute without reviewing P99 peak utilization can trigger out-of-memory crashes and auto-recovery churn.',
        'Evaluate 30-day P99 memory metrics alongside CPU before triggering automated rightsizing recommendations.'
      ),
    ],
    interactiveLabId: 'landing-zone-builder-output',
    ecosystemPartnerValidation: labCheck(
      'FinOps Foundation FOCUS 1.4 BigQuery & DuckDB Analytics Engine',
      'landing-zone-builder-output'
    ),
    tags: ['FinOps', 'Multi-Cloud', 'Cost Optimization', 'FOCUS'],
  },
  'real-time-cost-dashboard': {
    title: 'Real-time Cost Dashboard',
    category: 'Reporting',
    complexity: 'Production',
    description:
      'Streaming dashboard pattern for near real-time cloud spend visibility across business units, products, and environments.',
    promise:
      'Sub-minute cloud spend anomaly detection and hourly cost attribution dashboards powered by streaming telemetry.',
    estimatedCost: '$1,000 - $1,600 / month',
    topology: {
      caption: 'Streaming cloud cost telemetry and real-time visualization pipeline',
      surrounding: [
        'Pub/Sub Messaging',
        'Dataflow Streaming',
        'Real-time Dashboards',
        'Alert Webhooks',
      ],
      stages: [
        stage(
          'stream-ingest',
          'Cloud Usage Metric Streaming',
          'Captures hourly and streaming usage telemetry from cloud audit and monitoring feeds.',
          'Telemetry Ingress',
          'Encrypted Streaming'
        ),
        stage(
          'stream-processing',
          'Stream Transformation & Attribution',
          'Enriches raw usage records with budget thresholds, cost center metadata, and anomaly tags.',
          'Stream Processor',
          'Windowed Aggregations'
        ),
        stage(
          'timeseries-store',
          'High-Velocity Cost Store',
          'Low-latency time-series storage supporting instant slice-and-dice queries.',
          'Analytical Store',
          'Automated Compaction'
        ),
        stage(
          'executive-dashboard',
          'Interactive Operations Display',
          'Real-time visualization with sub-minute spend surge alarms and budget burn charts.',
          'Reporting Layer',
          'Role-Based Access'
        ),
      ],
    },
    hotspots: [
      hotspot(
        'spot-stream',
        [25, 40],
        'Telemetry Stream',
        'Streaming Ingress',
        'Collects live metric telemetry and usage events.'
      ),
      hotspot(
        'spot-enrich',
        [55, 55],
        'Attribution Engine',
        'Real-time Attribution',
        'Calculates amortized spend and compares with budget lines.'
      ),
      hotspot(
        'spot-dash',
        [80, 65],
        'Live Dashboard',
        'Visualization Board',
        'Displays live burn rates and cost anomalies per team.'
      ),
    ],
    services: [
      service(
        'Dataflow Streaming Engine',
        'water_drop',
        'Processes streaming cloud usage telemetry with sliding window anomaly detection.'
      ),
      service(
        'BigQuery Streaming Buffer',
        'input',
        'Receives high-frequency cost events for instant analytical query readiness.'
      ),
      service(
        'Cloud Pub/Sub',
        'send',
        'Transports usage events and spend alert triggers with low latency.'
      ),
      service(
        'Looker Studio',
        'dashboard',
        'Delivers real-time executive and engineering spend visualization screens.'
      ),
    ],
    practices: [
      'Establish sliding 1-hour and 24-hour anomaly detection windows to catch unexpected cloud spend spikes.',
      'Provide team-level filtered views so engineers see their direct deployment budget impact.',
      'Maintain automated webhook alerts routing to incident management channels when run rates spike.',
    ],
    outcome: [
      'Transforms reactive end-of-month billing surprises into proactive, intraday spend management.',
    ],
    overview: `
      <h2>Architecture Overview</h2>
      <p>This reference pattern establishes a streaming FinOps reporting pipeline that captures cloud usage events in real time, computes current burn rates, and alerts engineers immediately when anomalous spend occurs.</p>
    `,
    waf: wafScores([90, 93, 95, 95, 96], {
      operational: 'Real-time alerting and visible team accountability metrics.',
    }),
    terraformCode: `resource "google_pubsub_topic" "cost_stream" {
  name = "finops-cost-events"
}`,
    interactiveLabId: 'landing-zone-builder-output',
    whenNotToUse: [
      'Organizations with monthly cloud spend below $25,000 where native portal billing views and daily FOCUS 1.4 exports provide sufficient visibility.',
      'Batch-oriented workloads where intraday spend changes do not affect operational decision-making.',
    ],
    finopsCostTraps: [
      costTrap(
        'Dataflow Streaming Worker Baseline',
        'Running 24/7 Dataflow streaming workers with unoptimized machine types can cost $400 - $800/month, surpassing the cost anomalies it catches.',
        'Use micro-batch Dataflow jobs scheduled hourly or serverless Cloud Functions for low-volume telemetry streams to avoid standing cluster costs.'
      ),
      costTrap(
        'BigQuery High-Frequency Streaming Insert Fees',
        'Streaming millions of raw usage telemetry rows into BigQuery generates continuous insert fees ($0.05 per GB inserted).',
        'Buffer streaming events in Pub/Sub and use BigQuery Storage Write API with batch commits to minimize insertion costs.'
      ),
    ],
    tags: ['FinOps', 'Dashboards', 'Streaming', 'Analytics'],
  },
  'chargeback-allocation': {
    title: 'Chargeback & Allocation',
    category: 'Billing',
    complexity: 'Standard',
    description:
      'Allocation framework for unit-economics reporting with cost ownership, shared resource split rules, and monthly chargeback automation.',
    promise:
      '100% allocation of shared Kubernetes and network egress costs back to business units using configurable proportionality algorithms.',
    estimatedCost: '$700 - $1,200 / month',
    topology: {
      caption: 'Shared cost pool decomposition and automated chargeback allocation pipeline',
      surrounding: [
        'ERP Integration',
        'Cluster Telemetry',
        'Shared Network Hub',
        'Billing Reports',
      ],
      stages: [
        stage(
          'shared-pools',
          'Shared Infrastructure Pools',
          'Aggregates shared costs: Kubernetes clusters, transit gateways, support tiers, and logging.',
          'Shared Cost Pool',
          'Audit Logging'
        ),
        stage(
          'split-rules',
          'Allocation Engine & Split Rules',
          'Applies proportional consumption algorithms based on CPU, memory, and network bytes.',
          'Allocation Logic',
          'Mathematical Reconciliation'
        ),
        stage(
          'unit-economics',
          'Unit Economics Calculation',
          'Correlates allocated cloud spend with business KPIs such as transactions or active users.',
          'Business Intelligence',
          'Historical Baseline'
        ),
        stage(
          'ledger-export',
          'Financial Ledger & Chargeback',
          'Exports clean journal entries to corporate ERP systems for monthly internal billing.',
          'Finance Gateway',
          'GAAP Compliance'
        ),
      ],
    },
    hotspots: [
      hotspot(
        'spot-pool',
        [25, 40],
        'Shared Pool',
        'Unallocated Resources',
        'Centralizes shared network, Kubernetes, and support expenditures.'
      ),
      hotspot(
        'spot-rules',
        [55, 55],
        'Split Rules',
        'Proportional Algorithms',
        'Distributes shared costs based on actual container resource usage.'
      ),
      hotspot(
        'spot-ledger',
        [80, 65],
        'Finance Ledger',
        'ERP Journal Export',
        'Generates automated chargeback reports for finance.'
      ),
    ],
    services: [
      service(
        'Cloud Billing Allocation Engine',
        'calculate',
        'Decomposes shared resource pools into granular cost slices.'
      ),
      service(
        'Container Cost Telemetry',
        'view_in_ar',
        'Extracts pod-level CPU and memory consumption to calculate cluster chargeback.'
      ),
      service(
        'BigQuery Financial Models',
        'table_chart',
        'Runs reconciliation queries balancing allocated costs to invoice totals.'
      ),
      service(
        'Cloud Workflow Scheduler',
        'schedule',
        'Triggers monthly chargeback report generation and journal distribution.'
      ),
    ],
    practices: [
      'Reconcile allocated totals with raw provider invoices to ensure zero untracked unallocated cost.',
      'Combine static tag allocations with dynamic metric allocations for container workloads.',
      'Publish transparent allocation formulas to all engineering product owners.',
    ],
    outcome: [
      'Establishes clear financial accountability by distributing 100% of shared cloud infrastructure costs.',
    ],
    overview: `
      <h2>Architecture Overview</h2>
      <p>This architecture automates the decomposition and chargeback of shared cloud resources, ensuring every dollar spent on shared clusters, networks, and licenses is assigned to a responsible cost center.</p>
    `,
    waf: wafScores([91, 92, 90, 97, 93], {
      cost: 'Eliminates unassigned overhead with automated proportionality algorithms.',
    }),
    terraformCode: `resource "google_bigquery_routine" "chargeback_split" {
  dataset_id   = "finops_allocation"
  routine_id   = "calculate_kubernetes_chargeback"
  routine_type = "PROCEDURE"
  language     = "SQL"
  definition_body = "SELECT 1;"
}`,
    interactiveLabId: 'landing-zone-builder-output',
    whenNotToUse: [
      'Single-product companies with unified budgets where engineering spend is treated as a shared operational expense rather than charged to departments.',
      'Teams lacking basic resource tagging hygiene, where unallocated overhead exceeds 60% of total spend.',
    ],
    finopsCostTraps: [
      costTrap(
        'Over-Engineered Allocation ETL Pipelines',
        'Running complex multi-pass BigQuery SQL routines over multi-year FOCUS 1.4 billing datasets without partition pruning runs up compute fees.',
        'Partition allocation staging tables by ChargePeriodStart (DAY) and cluster by ProviderName and SubAccountId to minimize scan costs.'
      ),
      costTrap(
        'Shared Container Cost Telemetry Overhead',
        'Running heavy metric collection daemons on every Kubernetes node consumes 5% to 10% of cluster CPU/memory capacity just for chargeback telemetry.',
        'Adopt lightweight eBPF or OpenTelemetry metrics collectors with downsampled scrape intervals (e.g. 60 seconds) on shared clusters.'
      ),
    ],
    tags: ['FinOps', 'Chargeback', 'Allocation', 'Unit Economics'],
  },
  'ri-savings-plan-automation': {
    title: 'RI & Savings Plan Automation',
    category: 'Automation',
    complexity: 'Production',
    description:
      'Automation workflow for committed-use planning, purchase simulation, and policy-based guardrails to reduce avoidable spend.',
    promise:
      'Continuous coverage targeting with risk-managed break-even simulation, minimizing unblended on-demand compute overages.',
    estimatedCost: '$1,600 - $2,500 / month',
    topology: {
      caption: 'Commitment discount evaluation, purchase simulation, and coverage guardrails',
      surrounding: [
        'Commitment API',
        'Risk Modeling Engine',
        'Approval Gateway',
        'Expiration Monitor',
      ],
      stages: [
        stage(
          'baseline-analysis',
          'Historical Baseline Analyzer',
          'Evaluates rolling 30/60/90-day stable compute, memory, and database usage footprints.',
          'Usage Profiler',
          'Seasonality Smoothing'
        ),
        stage(
          'break-even-sim',
          'Commitment Simulation Engine',
          'Simulates 1-year and 3-year commitment discount curves to identify break-even horizons.',
          'Risk Calculator',
          'Utilization Floor'
        ),
        stage(
          'approval-dispatch',
          'Approval & Notification Gate',
          'Dispatches purchase recommendation packets to finance and platform stakeholders.',
          'Governance Gate',
          'Dual Sign-Off'
        ),
        stage(
          'portfolio-monitor',
          'Commitment Lifecycle Monitor',
          'Continuously monitors portfolio expiration dates and flags expiring terms 60 days ahead.',
          'Portfolio Tracker',
          'Expiration Alerts'
        ),
      ],
    },
    hotspots: [
      hotspot(
        'spot-baseline',
        [25, 40],
        'Usage Baseline',
        'Historical Compute',
        'Identifies stable continuous compute floor across regions.'
      ),
      hotspot(
        'spot-sim',
        [55, 50],
        'Discount Simulator',
        'Break-Even Model',
        'Models savings vs commitment risk across contract tiers.'
      ),
      hotspot(
        'spot-alerts',
        [80, 65],
        'Expiration Tracker',
        'Lifecycle Warnings',
        'Alerts finance before commitment windows lapse.'
      ),
    ],
    services: [
      service(
        'Cloud Commitment Recommendations API',
        'savings',
        'Surfaces native provider reserved instance and committed use discount recommendations.'
      ),
      service(
        'Commitment Modeling Engine',
        'tune',
        'Simulates blended compute and flexible savings plan trade-offs.'
      ),
      service(
        'Automation Worker',
        'bolt',
        'Executes automated recommendation digestion and notification dispatch.'
      ),
      service(
        'Cloud Monitoring Alerts',
        'notifications_active',
        'Sends 60-day, 30-day, and 15-day commitment expiry notifications.'
      ),
    ],
    practices: [
      'Maintain a target commitment coverage between 70% and 85% of baseline capacity to prevent over-commitment.',
      'Prioritize flexible compute commitment tiers over rigid single-zone instance reservations.',
      'Conduct quarterly reviews of expiring commitments to stagger expiration waves.',
    ],
    outcome: [
      'Achieves 30% to 50% compute cost savings through continuous, automated commitment portfolio management.',
    ],
    overview: `
      <h2>Architecture Overview</h2>
      <p>This automation blueprint optimizes cloud commitment purchases by analyzing baseline compute demand, modeling break-even timelines, and providing structured workflows for reserved capacity management.</p>
    `,
    waf: wafScores([91, 93, 91, 99, 94], {
      cost: 'Automated break-even simulation driving 30-50% sustained compute discounts.',
    }),
    terraformCode: `resource "google_monitoring_alert_policy" "commitment_expiration" {
  display_name = "Commitment Expiration Warning (60 Days)"
  combiner     = "OR"
  conditions {
    display_name = "Expiring Commitments"
    condition_threshold {
      filter = "resource.type = \\"billing_account\\""
    }
  }
}`,
    interactiveLabId: 'terraform-validate-walkthrough',
    whenNotToUse: [
      'Dynamic startups undergoing major architecture replatforming (e.g. migrating VM fleets to serverless or Kubernetes within 6 months).',
      'Workloads with highly seasonal, unpredictable traffic where commitment utilization would fall below break-even thresholds (typically 65-70%).',
    ],
    finopsCostTraps: [
      costTrap(
        '3-Year All-Upfront Commitment Lock-in',
        'Purchasing 3-year all-upfront instance-specific reservations on aging compute families creates high break-even risk when new instance generations launch.',
        'Favor 1-year No-Upfront or Partial-Upfront Compute Savings Plans and flexible CUDs, maintaining commitment coverage targets around 75% to 80%.'
      ),
      costTrap(
        'Unmonitored Commitment Waste (Idle Utilization)',
        'Underutilized commitments continue to incur amortization charges in FOCUS 1.4 EffectiveCost even when compute instances are terminated.',
        'Configure automated Slack alerts when hourly commitment utilization dips below 90%, and trade unneeded reservations on the AWS Reserved Instance Marketplace.'
      ),
    ],
    tags: ['FinOps', 'Automation', 'Savings Plans', 'Reserved Instances'],
  },
  'budget-policy-framework': {
    title: 'Budget & Policy Framework',
    category: 'Governance',
    complexity: 'Mission Critical',
    description:
      'Governance architecture tying budget thresholds to policy enforcement, alert routing, and escalation workflows by cost center.',
    promise:
      'Automated policy enforcement shutting down non-production sandbox sprawl when thresholds exceed 100% without business justification.',
    estimatedCost: '$1,200 - $1,900 / month',
    topology: {
      caption:
        'Hierarchical budget allocation, multi-tier threshold alerting, and policy enforcement',
      surrounding: [
        'Budget API',
        'Cloud Organization Policies',
        'Notification Routing',
        'Automated Guardrails',
      ],
      stages: [
        stage(
          'hierarchical-budgets',
          'Hierarchical Budget Allocations',
          'Granular budget scopes tied to billing accounts, projects, folders, and cost centers.',
          'Budget Registry',
          'Strict Quotas'
        ),
        stage(
          'multi-threshold-alerts',
          'Graduated Alert Triggers',
          'Configured triggers at 50%, 80%, 100%, and 120% of forecast monthly run rates.',
          'Notification Bus',
          'Tiered Escalation'
        ),
        stage(
          'policy-guardrail',
          'Automated Guardrail Enforcement',
          'Organization Policies restricting expensive VM creation when budgets breach.',
          'Policy Controller',
          'Policy Constraints'
        ),
        stage(
          'sandbox-management',
          'Sandbox Auto-Containment',
          'Terminates runaway sandbox test environments when hard spend ceilings are surpassed.',
          'Remediation Worker',
          'Automated Shutdown'
        ),
      ],
    },
    hotspots: [
      hotspot(
        'spot-budgets',
        [25, 40],
        'Org Budgets',
        'Hierarchical Quotas',
        'Enforces budget limits aligned with department cost centers.'
      ),
      hotspot(
        'spot-thresholds',
        [55, 55],
        'Alert Tiers',
        'Forecast Triggers',
        'Notifies cost owners when projected burn exceeds targets.'
      ),
      hotspot(
        'spot-containment',
        [80, 65],
        'Auto-Containment',
        'Policy Guardrail',
        'Disables expensive provisioning in sandbox environments on breach.'
      ),
    ],
    services: [
      service(
        'Cloud Billing Budget API',
        'account_balance_wallet',
        'Defines programmatic budget scopes, forecast thresholds, and alert channels.'
      ),
      service(
        'Cloud Organization Policies',
        'policy',
        'Enforces resource creation constraints based on project tags and compliance status.'
      ),
      service(
        'Auto-Remediation Worker',
        'build',
        'Executes automated containment actions for sandbox environments exceeding budgets.'
      ),
      service(
        'Notification Channels',
        'mail',
        'Routes actionable notifications to Slack, PagerDuty, and email distribution groups.'
      ),
    ],
    practices: [
      'Configure budget thresholds on both actual spend and projected monthly forecast.',
      'Implement hard limits with automated remediation strictly in sandbox and lab environments.',
      'Require explicit business justification before raising project budget caps.',
    ],
    outcome: [
      'Prevents unexpected billing shocks and maintains organizational discipline through automated governance.',
    ],
    overview: `
      <h2>Architecture Overview</h2>
      <p>This governance blueprint establishes a comprehensive budget and policy framework that couples automated alerting with policy enforcement to prevent runaway infrastructure costs.</p>
    `,
    waf: wafScores([94, 93, 91, 98, 97], {
      cost: 'Tiered budget alerting with automated non-production containment.',
    }),
    terraformCode: `resource "google_billing_budget" "budget" {
  billing_account = "012345-567890-ABCDEF"
  display_name    = "Production Department Budget"
  amount {
    specified_amount {
      currency_code = "USD"
      units         = "10000"
    }
  }
}`,
    interactiveLabId: 'terraform-validate-walkthrough',
    whenNotToUse: [
      'Early-stage rapid prototyping labs where aggressive automated shutdowns or hard resource creation blocks disrupt critical product iterations.',
      'Organizations without clear escalation paths or budget owners to respond to automated notification thresholds.',
    ],
    finopsCostTraps: [
      costTrap(
        'Automated Shutdown Data Loss & Recovery Costs',
        'Hard containment scripts terminating unbudgeted sandbox instances can destroy uncommitted stateful data, triggering costly engineering recovery.',
        'Implement a graceful containment sequence: stop compute instances first and create automated snapshot backups before permanent volume termination.'
      ),
      costTrap(
        'Alert Fatigue & Unrouted Notification Sprawl',
        'Sending low-threshold (50%) alerts to broad email distribution groups causes engineers to ignore notifications until critical 100% breaches occur.',
        'Route alerts to dedicated engineering Slack/Teams channels using tiered severity and tag-based ownership routing.'
      ),
    ],
    tags: ['FinOps', 'Governance', 'Budgets', 'Policy'],
  },
  'waste-identification-alerts': {
    title: 'Waste Identification & Alerts',
    category: 'Optimization',
    complexity: 'Production',
    description:
      'Continuous anomaly and idle-resource detection pipeline with actionable alerts for compute, storage, and network waste classes.',
    promise:
      'Automated scanning for unattached persistent disks, orphaned load balancers, and idle compute instances saving thousands each billing cycle.',
    estimatedCost: '$1,100 - $1,700 / month',
    topology: {
      caption:
        'Continuous waste scanning, classification, and automated cleanup recommendation pipeline',
      surrounding: [
        'Resource Graph API',
        'Recommender Service',
        'Notification Integration',
        'Cleanup Automation',
      ],
      stages: [
        stage(
          'resource-inventory',
          'Full Asset Inventory Scan',
          'Daily crawl across all subscriptions and projects inventorying live cloud assets.',
          'Crawler Agent',
          'Read-Only Scanner'
        ),
        stage(
          'waste-classifier',
          'Heuristic Waste Classifier',
          'Evaluates utilization metrics to flag unattached disks, idle IPs, and dormant VMs.',
          'Classification Engine',
          'False Positive Filter'
        ),
        stage(
          'digest-generation',
          'Actionable Digest Routing',
          'Aggregates cleanup candidates into weekly department reports with direct 1-click remediation links.',
          'Digest Publisher',
          'Owner Attribution'
        ),
        stage(
          'automated-cleanup',
          'Policy-Based Cleanup Engine',
          'Deletes orphaned sandbox snapshots and unattached disks older than 30 days.',
          'Execution Worker',
          'Snapshot Backup First'
        ),
      ],
    },
    hotspots: [
      hotspot(
        'spot-scan',
        [25, 40],
        'Asset Scan',
        'Inventory Crawler',
        'Crawls all active resources to detect unattached or unused assets.'
      ),
      hotspot(
        'spot-classify',
        [55, 55],
        'Waste Classifier',
        'Heuristic Rules',
        'Flags unattached storage, idle load balancers, and dormant compute.'
      ),
      hotspot(
        'spot-cleanup',
        [80, 65],
        'Cleanup Worker',
        'Remediation Action',
        'Executes automated pruning with pre-deletion snapshot backups.'
      ),
    ],
    services: [
      service(
        'Cloud Asset Inventory',
        'inventory',
        'Provides real-time metadata scanning across organizational project hierarchies.'
      ),
      service(
        'Cloud Recommender',
        'auto_fix_high',
        'Detects idle compute instances, unattached disks, and oversized database tiers.'
      ),
      service(
        'Eventarc Automation Trigger',
        'sync',
        'Dispatches cleanup candidate notifications to team webhooks and review queues.'
      ),
      service(
        'Cloud Snapshot Archive',
        'camera_alt',
        'Preserves pre-deletion recovery snapshots before unattached disks are recycled.'
      ),
    ],
    practices: [
      'Enforce mandatory pre-deletion snapshots before any automated disk or volume cleanup.',
      'Run idle resource scans daily, publishing findings to workload owners for verification.',
      'Treat unattached static IP addresses and empty load balancers as immediate cleanup priorities.',
    ],
    outcome: [
      'Recovers 15% to 25% of cloud expenditure by eliminating dormant, orphaned, and idle cloud assets.',
    ],
    overview: `
      <h2>Architecture Overview</h2>
      <p>This automated waste identification blueprint scans cloud environments continuously for unattached storage volumes, dormant virtual machines, idle load balancers, and orphaned IP allocations.</p>
    `,
    waf: wafScores([91, 94, 92, 98, 95], {
      cost: 'Automated pruning of unattached disks and orphaned network resources.',
    }),
    terraformCode: `resource "google_cloud_scheduler_job" "waste_audit" {
  name             = "weekly-waste-audit"
  description      = "Triggers weekly idle resource scan"
  schedule         = "0 2 * * 1"
  time_zone        = "Etc/UTC"
  attempt_deadline = "320s"
}`,
    interactiveLabId: 'landing-zone-builder-output',
    whenNotToUse: [
      'Ephemeral, short-lived CI/CD environments where container nodes and disks cycle dynamically and appear "idle" to heuristic scanners.',
      'Environments without automated tagging or ownership mapping, leaving waste alerts with no actionable team owner.',
    ],
    finopsCostTraps: [
      costTrap(
        'Indiscriminate Orphaned Snapshot Pruning',
        'Automated deletion of "unattached" disks or snapshots without age verification can wipe out manual disaster recovery backups or golden images.',
        'Enforce strict retention rules (e.g. minimum 30 days unattached), tag exemptions (keep-alive=true), and pre-deletion metadata archives.'
      ),
      costTrap(
        'Resource Graph & Inventory API Query Quotas',
        'Polling cloud asset inventory and resource graph APIs every few minutes across thousands of subscriptions triggers API rate-limit throttling fees.',
        'Schedule comprehensive asset crawls once or twice daily during off-peak hours and use event-driven triggers for real-time asset changes.'
      ),
    ],
    tags: ['FinOps', 'Optimization', 'Waste Reduction', 'Automation'],
  },
};

export const architecturesByProvider = {
  aws: awsArchitectures,
  azure: azureArchitectures,
  gcp: gcpArchitectures,
  finops: finopsArchitectures,
};
