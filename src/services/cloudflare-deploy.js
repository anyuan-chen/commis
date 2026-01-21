import { exec } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { config } from '../config.js';
import { MaterialModel } from '../db/models/index.js';

const execAsync = promisify(exec);

export class CloudflareDeployer {
  constructor() {
    this.accountId = config.cloudflareAccountId;
    this.apiToken = config.cloudflareApiToken;
  }

  /**
   * Deploy a restaurant's website to Cloudflare Pages
   */
  async deploy(restaurantId) {
    const websitePath = join(config.paths.websites, restaurantId);

    // Generate a project name from restaurant ID
    const projectName = `restaurant-${restaurantId.slice(0, 8)}`;

    try {
      // Deploy using wrangler
      const { stdout, stderr } = await execAsync(
        `npx wrangler pages deploy "${websitePath}" --project-name="${projectName}" --commit-dirty=true`,
        {
          env: {
            ...process.env,
            CLOUDFLARE_ACCOUNT_ID: this.accountId,
            CLOUDFLARE_API_TOKEN: this.apiToken
          },
          cwd: config.paths.root
        }
      );

      // Parse the URL from wrangler output
      const urlMatch = stdout.match(/https:\/\/[^\s]+\.pages\.dev/);
      const deployedUrl = urlMatch ? urlMatch[0] : null;

      if (!deployedUrl) {
        console.log('Wrangler output:', stdout);
        console.error('Wrangler stderr:', stderr);
      }

      // Update material record with URL
      const material = MaterialModel.getLatestByType(restaurantId, 'website');
      if (material && deployedUrl) {
        MaterialModel.updateCloudflareUrl(material.id, deployedUrl);
      }

      return {
        success: true,
        url: deployedUrl,
        projectName,
        output: stdout
      };
    } catch (error) {
      console.error('Deployment error:', error);
      throw new Error(`Deployment failed: ${error.message}`);
    }
  }

  /**
   * Check if a project exists on Cloudflare Pages
   */
  async projectExists(projectName) {
    try {
      const { stdout } = await execAsync(
        `npx wrangler pages project list --json`,
        {
          env: {
            ...process.env,
            CLOUDFLARE_ACCOUNT_ID: this.accountId,
            CLOUDFLARE_API_TOKEN: this.apiToken
          },
          cwd: config.paths.root
        }
      );

      const projects = JSON.parse(stdout);
      return projects.some(p => p.name === projectName);
    } catch {
      return false;
    }
  }

  /**
   * Get deployment status for a project
   */
  async getDeploymentStatus(projectName) {
    try {
      const { stdout } = await execAsync(
        `npx wrangler pages deployment list --project-name="${projectName}" --json`,
        {
          env: {
            ...process.env,
            CLOUDFLARE_ACCOUNT_ID: this.accountId,
            CLOUDFLARE_API_TOKEN: this.apiToken
          },
          cwd: config.paths.root
        }
      );

      const deployments = JSON.parse(stdout);
      return deployments[0] || null;
    } catch (error) {
      console.error('Failed to get deployment status:', error);
      return null;
    }
  }
}
