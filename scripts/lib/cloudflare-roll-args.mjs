/** The command line of roll-cloudflare-tokens.mjs: its flags, and the usage text it prints. */

/**
 * Parses CLI arguments into an options bag. Rejects unknown flags and
 * flags with missing operands (exits or reports error).
 *
 * @param {string[]} argv
 * @returns {object}
 */
export function parseArgs(argv) {
  const options = {
    target: 'all',
    tokenId: null,
    dryRun: false,
    check: false,
    help: false,
    invalid: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else if (arg === '--dry-run') {
      options.dryRun = true;
    } else if (arg === '--check') {
      options.check = true;
    } else if (arg === '--target') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        options.invalid = 'Option --target requires a target operand (azure, lab, caddy, or all)';
        return options;
      }
      options.target = argv[++i];
    } else if (arg === '--token-id') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        options.invalid = 'Option --token-id requires a non-empty token ID operand';
        return options;
      }
      options.tokenId = argv[++i];
    } else {
      options.invalid = `Unrecognized option: '${arg}'`;
      return options;
    }
  }

  return options;
}

/**
 * Prints usage instructions.
 */
export function printUsage(stdout = console.log) {
  stdout(`Usage: roll-cloudflare-tokens.mjs [options]

Renew Cloudflare API tokens using the roll-token endpoint and write back
to HCP Terraform workspaces or the lab host's Ansible Vault (#1027).

Options:
  --target <target>     Target to renew: 'azure', 'lab', 'caddy', or 'all' (default: 'all')
  --token-id <id>       Override Cloudflare token ID (allowed only with a single target)
  --dry-run             Validate configuration and display actions without rolling or writing
  --check               Verify that configured tokens and workspace targets are reachable
  --help, -h            Show this help message

Environment variables:
  CLOUDFLARE_ROLL_TOKEN   Cloudflare API token with 'API Tokens:Edit' permission (or CLOUDFLARE_API_TOKEN)
  CLOUDFLARE_ACCOUNT_ROLL_TOKEN  Optional: a token with 'Account API Tokens:Edit' for account-owned
                          tokens (azure); CLOUDFLARE_ROLL_TOKEN is used when unset
  CLOUDFLARE_ACCOUNT_ID   The Cloudflare account id, needed for account-owned tokens (azure)
  TFC_TOKEN               HCP Terraform token for workspace variables (or TFE_TOKEN)
  CLOUDFLARE_AZURE_TOKEN_ID   Cloudflare token ID for the Azure HCP Terraform workspace (account-owned token 'hcw')
  CLOUDFLARE_LAB_TOKEN_ID     Cloudflare token ID for the Lab HCP Terraform workspace
  CLOUDFLARE_CADDY_TOKEN_ID   Cloudflare token ID for the Lab host Caddy Ansible Vault
`);
}
