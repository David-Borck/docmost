import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Res,
  UseGuards,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { LoginDto } from './dto/login.dto';
import { LdapLoginDto } from './dto/ldap-login.dto';
import { AuthService } from './services/auth.service';
import { LdapService } from './services/ldap.service';
import { SetupGuard } from './guards/setup.guard';
import { EnvironmentService } from '../../integrations/environment/environment.service';
import { CreateAdminUserDto } from './dto/create-admin-user.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { AuthUser } from '../../common/decorators/auth-user.decorator';
import { User, Workspace } from '@docmost/db/types/entity.types';
import { AuthWorkspace } from '../../common/decorators/auth-workspace.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { PasswordResetDto } from './dto/password-reset.dto';
import { VerifyUserTokenDto } from './dto/verify-user-token.dto';
import { FastifyReply } from 'fastify';
import { validateSsoEnforcement } from './auth.util';
import { ModuleRef } from '@nestjs/core';
import { SignupService } from './services/signup.service';
import { CreateUserDto } from './dto/create-user.dto';

@Controller('auth')
export class AuthController {
  private readonly logger = new Logger(AuthController.name);

  constructor(
    private authService: AuthService,
    private ldapService: LdapService,
    private signupService: SignupService,
    private environmentService: EnvironmentService,
    private moduleRef: ModuleRef,
  ) {}

  @HttpCode(HttpStatus.OK)
  @Post('login')
  async login(
    @AuthWorkspace() workspace: Workspace,
    @Res({ passthrough: true }) res: FastifyReply,
    @Body() loginInput: LoginDto,
  ) {
    validateSsoEnforcement(workspace);

    let MfaModule: any;
    let isMfaModuleReady = false;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      MfaModule = require('./../../ee/mfa/services/mfa.service');
      isMfaModuleReady = true;
    } catch (err) {
      this.logger.debug(
        'MFA module requested but EE module not bundled in this build',
      );
      isMfaModuleReady = false;
    }
    if (isMfaModuleReady) {
      const mfaService = this.moduleRef.get(MfaModule.MfaService, {
        strict: false,
      });

      const mfaResult = await mfaService.checkMfaRequirements(
        loginInput,
        workspace,
        res,
      );

      if (mfaResult) {
        // If user has MFA enabled OR workspace enforces MFA, require MFA verification
        if (mfaResult.userHasMfa || mfaResult.requiresMfaSetup) {
          return {
            userHasMfa: mfaResult.userHasMfa,
            requiresMfaSetup: mfaResult.requiresMfaSetup,
            isMfaEnforced: mfaResult.isMfaEnforced,
          };
        } else if (mfaResult.authToken) {
          // User doesn't have MFA and workspace doesn't require it
          this.setAuthCookie(res, mfaResult.authToken);
          return;
        }
      }
    }

    const authToken = await this.authService.login(loginInput, workspace.id);
    this.setAuthCookie(res, authToken);
  }

  @UseGuards(SetupGuard)
  @HttpCode(HttpStatus.OK)
  @Post('setup')
  async setupWorkspace(
    @Res({ passthrough: true }) res: FastifyReply,
    @Body() createAdminUserDto: CreateAdminUserDto,
  ) {
    const { workspace, authToken } =
      await this.authService.setup(createAdminUserDto);

    this.setAuthCookie(res, authToken);
    return workspace;
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('change-password')
  async changePassword(
    @Body() dto: ChangePasswordDto,
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.authService.changePassword(dto, user.id, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('forgot-password')
  async forgotPassword(
    @Body() forgotPasswordDto: ForgotPasswordDto,
    @AuthWorkspace() workspace: Workspace,
  ) {
    validateSsoEnforcement(workspace);
    return this.authService.forgotPassword(forgotPasswordDto, workspace);
  }

  @HttpCode(HttpStatus.OK)
  @Post('password-reset')
  async passwordReset(
    @Res({ passthrough: true }) res: FastifyReply,
    @Body() passwordResetDto: PasswordResetDto,
    @AuthWorkspace() workspace: Workspace,
  ) {
    const result = await this.authService.passwordReset(
      passwordResetDto,
      workspace,
    );

    if (result.requiresLogin) {
      return {
        requiresLogin: true,
      };
    }

    // Set auth cookie if no MFA is required
    this.setAuthCookie(res, result.authToken);
    return {
      requiresLogin: false,
    };
  }

  @HttpCode(HttpStatus.OK)
  @Post('verify-token')
  async verifyResetToken(
    @Body() verifyUserTokenDto: VerifyUserTokenDto,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.authService.verifyUserToken(verifyUserTokenDto, workspace.id);
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('collab-token')
  async collabToken(
    @AuthUser() user: User,
    @AuthWorkspace() workspace: Workspace,
  ) {
    return this.authService.getCollabToken(user, workspace.id);
  }

  @HttpCode(HttpStatus.OK)
  @Post('login-ldap')
  async loginLdap(
    @AuthWorkspace() workspace: Workspace,
    @Res({ passthrough: true }) res: FastifyReply,
    @Body() ldapLoginDto: LdapLoginDto,
  ) {
    // Authenticate user with LDAP
    const ldapResult = await this.ldapService.authenticate(
      ldapLoginDto.username,
      ldapLoginDto.password,
    );

    // Find existing user by email
    let user = await this.authService['userRepo'].findByEmail(
      ldapResult.user.email,
      workspace.id,
    );

    // Create user if not exists and signup is allowed
    if (!user && this.environmentService.getLdapAllowSignup()) {
      this.logger.log(
        `Auto-creating user from LDAP: ${ldapResult.user.email}`,
      );

      const createUserDto: CreateUserDto = {
        email: ldapResult.user.email,
        name: ldapResult.user.name,
        password: null, // LDAP users don't have local passwords
      };

      user = await this.signupService.signup(createUserDto, workspace.id);

      // Mark user as having a generated (non-usable) password
      await this.authService['userRepo'].updateUser(
        { hasGeneratedPassword: true },
        user.id,
        workspace.id,
      );
    }

    if (!user) {
      throw new UnauthorizedException(
        'User not found. LDAP signup is disabled.',
      );
    }

    // Update last login
    await this.authService['userRepo'].updateLastLogin(user.id, workspace.id);

    // Generate JWT token
    const authToken = await this.authService['tokenService'].generateAccessToken(
      user,
    );

    this.setAuthCookie(res, authToken);
    this.logger.log(`LDAP login successful for user: ${user.email}`);
  }

  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Post('logout')
  async logout(@Res({ passthrough: true }) res: FastifyReply) {
    res.clearCookie('authToken');
  }

  setAuthCookie(res: FastifyReply, token: string) {
    res.setCookie('authToken', token, {
      httpOnly: true,
      path: '/',
      expires: this.environmentService.getCookieExpiresIn(),
      secure: this.environmentService.isHttps(),
    });
  }
}
