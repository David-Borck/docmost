import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { Client } from 'ldapts';
import { EnvironmentService } from '../../../integrations/environment/environment.service';

export interface LdapUser {
  email: string;
  name: string;
  dn: string;
  attributes?: Record<string, any>;
}

export interface LdapAuthResult {
  user: LdapUser;
  authenticated: boolean;
}

@Injectable()
export class LdapService {
  private readonly logger = new Logger(LdapService.name);

  constructor(private environmentService: EnvironmentService) {}

  /**
   * Authenticate a user against the LDAP server
   * @param username - Username or email to authenticate
   * @param password - User password
   * @returns LdapAuthResult with user information
   * @throws UnauthorizedException if authentication fails
   */
  async authenticate(
    username: string,
    password: string,
  ): Promise<LdapAuthResult> {
    const ldapUrl = this.environmentService.getLdapUrl();
    const ldapBindDn = this.environmentService.getLdapBindDn();
    const ldapBindPassword = this.environmentService.getLdapBindPassword();
    const ldapBaseDn = this.environmentService.getLdapBaseDn();
    const ldapUserFilter = this.environmentService.getLdapUserFilter();
    const ldapTlsEnabled = this.environmentService.getLdapTlsEnabled();
    const ldapCaCert = this.environmentService.getLdapCaCert();

    if (!ldapUrl || !ldapBindDn || !ldapBindPassword || !ldapBaseDn) {
      this.logger.error('LDAP configuration is incomplete');
      throw new UnauthorizedException('LDAP authentication is not configured');
    }

    const client = new Client({
      url: ldapUrl,
      tlsOptions: ldapTlsEnabled
        ? {
            rejectUnauthorized: true,
            ca: ldapCaCert ? [ldapCaCert] : undefined,
          }
        : undefined,
    });

    try {
      // Step 1: Bind as service account
      this.logger.debug(
        `Binding to LDAP server as service account: ${ldapBindDn}`,
      );
      await client.bind(ldapBindDn, ldapBindPassword);

      // Step 2: Search for the user
      const searchFilter = ldapUserFilter.replace('{{username}}', username);
      this.logger.debug(
        `Searching for user in base DN: ${ldapBaseDn} with filter: ${searchFilter}`,
      );

      const { searchEntries } = await client.search(ldapBaseDn, {
        filter: searchFilter,
        scope: 'sub',
        attributes: [
          'mail',
          'displayName',
          'cn',
          'dn',
          'givenName',
          'sn',
          'memberOf',
        ],
      });

      if (searchEntries.length === 0) {
        this.logger.warn(`User not found in LDAP: ${username}`);
        throw new UnauthorizedException('Invalid credentials');
      }

      if (searchEntries.length > 1) {
        this.logger.warn(
          `Multiple users found for username: ${username}. Using first match.`,
        );
      }

      const userEntry = searchEntries[0];
      const userDn = userEntry.dn as string;

      this.logger.debug(`Found user DN: ${userDn}`);

      // Step 3: Verify user password by attempting to bind as the user
      try {
        await client.bind(userDn, password);
        this.logger.debug(`Successfully authenticated user: ${username}`);
      } catch (bindError) {
        const errorMessage = bindError instanceof Error ? bindError.message : 'Unknown error';
        this.logger.warn(`Failed to bind as user ${userDn}: ${errorMessage}`);
        throw new UnauthorizedException('Invalid credentials');
      }

      // Step 4: Extract user attributes
      const email = this.extractAttribute(userEntry, 'mail');
      const displayName = this.extractAttribute(userEntry, 'displayName');
      const cn = this.extractAttribute(userEntry, 'cn');
      const givenName = this.extractAttribute(userEntry, 'givenName');
      const sn = this.extractAttribute(userEntry, 'sn');

      // Determine user's name (prefer displayName, fallback to givenName + sn, then cn)
      let name = displayName;
      if (!name && givenName && sn) {
        name = `${givenName} ${sn}`;
      } else if (!name) {
        name = cn;
      }

      if (!email) {
        this.logger.error(`User ${userDn} has no email attribute`);
        throw new UnauthorizedException(
          'User account is missing required email attribute',
        );
      }

      const ldapUser: LdapUser = {
        email: email,
        name: name || email.split('@')[0], // Fallback to email username if no name
        dn: userDn,
        attributes: {
          displayName,
          cn,
          givenName,
          sn,
          memberOf: userEntry.memberOf,
        },
      };

      return {
        user: ldapUser,
        authenticated: true,
      };
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const errorStack = error instanceof Error ? error.stack : undefined;
      this.logger.error(`LDAP authentication error: ${errorMessage}`, errorStack);
      throw new UnauthorizedException('LDAP authentication failed');
    } finally {
      try {
        await client.unbind();
      } catch (unbindError) {
        const errorMessage = unbindError instanceof Error ? unbindError.message : 'Unknown error';
        this.logger.warn(`Error unbinding LDAP client: ${errorMessage}`);
      }
    }
  }

  /**
   * Test LDAP connection with service account
   * @returns true if connection successful
   */
  async testConnection(): Promise<boolean> {
    const ldapUrl = this.environmentService.getLdapUrl();
    const ldapBindDn = this.environmentService.getLdapBindDn();
    const ldapBindPassword = this.environmentService.getLdapBindPassword();
    const ldapTlsEnabled = this.environmentService.getLdapTlsEnabled();
    const ldapCaCert = this.environmentService.getLdapCaCert();

    if (!ldapUrl || !ldapBindDn || !ldapBindPassword) {
      return false;
    }

    const client = new Client({
      url: ldapUrl,
      tlsOptions: ldapTlsEnabled
        ? {
            rejectUnauthorized: true,
            ca: ldapCaCert ? [ldapCaCert] : undefined,
          }
        : undefined,
    });

    try {
      await client.bind(ldapBindDn, ldapBindPassword);
      await client.unbind();
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`LDAP connection test failed: ${errorMessage}`);
      return false;
    }
  }

  /**
   * Extract a single attribute value from LDAP entry
   */
  private extractAttribute(entry: any, attributeName: string): string | null {
    const value = entry[attributeName];
    if (!value) return null;

    // Handle both single values and arrays
    if (Array.isArray(value)) {
      return value.length > 0 ? String(value[0]) : null;
    }

    return String(value);
  }
}
