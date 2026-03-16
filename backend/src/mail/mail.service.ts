import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
    private transporter: nodemailer.Transporter;

    constructor(private configService: ConfigService) {
        const host = this.configService.get<string>('MAIL_HOST') || this.configService.get<string>('SMTP_HOST');
        const user = this.configService.get<string>('MAIL_USER') || this.configService.get<string>('SMTP_USER');

        if (!host || !user) {
            console.warn('WARNING: SMTP configuration is missing. Emails will fail to send.');
        }

        const portValue =
            this.configService.get<string>('MAIL_PORT') ??
            this.configService.get<string>('SMTP_PORT') ??
            '2525';
        const port = Number(portValue);

        const secureValue =
            this.configService.get<string>('MAIL_SECURE') ??
            this.configService.get<string>('SMTP_SECURE') ??
            'false';
        const secure = secureValue === 'true';

        this.transporter = nodemailer.createTransport({
            host,
            port,
            secure,
            auth: {
                user,
                pass: this.configService.get<string>('MAIL_PASSWORD') || this.configService.get<string>('SMTP_PASS'),
            },
            tls: {
                rejectUnauthorized:
                    (this.configService.get<string>('MAIL_TLS_REJECT_UNAUTHORIZED') ??
                        this.configService.get<string>('SMTP_TLS_REJECT_UNAUTHORIZED') ??
                        'true') === 'true',
            },
            connectionTimeout: 10000, // 10 seconds
            greetingTimeout: 10000,
            // @ts-ignore
            family: 4,
        } as nodemailer.TransportOptions);

        console.log(`[MailService] Transporter initialized for ${host}`);
    }

    async sendInvitationEmail(to: string, token: string, senderName?: string, senderEmail?: string) {
        const setupUrl = `${this.configService.get<string>('FRONTEND_URL') || 'http://localhost:5173'}/auth/setup-password?token=${token}`;

        // Use system email for 'From' but set display name to Team Manager
        // This ensures better deliverability (DMARC/SPF) while showing who sent it
        const systemFrom =
            this.configService.get<string>('MAIL_FROM_ADDRESS') ||
            this.configService.get<string>('SMTP_FROM');
        const fromDisplayName = senderName ? `${senderName} via CV Manager` : 'CV Manager';

        const mailOptions = {
            from: `"${fromDisplayName}" <${systemFrom}>`,
            to,
            replyTo: senderEmail, // Allow employee to reply directly to the manager
            subject: 'Join CV Manager - Invitation',
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px; border: 1px solid #e0e0e0; border-radius: 10px;">
                    <h2 style="color: #3b82f6;">Welcome to CV Manager</h2>
                    <p>Hello,</p>
                    <p>You have been invited to join our platform. Click the button below to set up your account and password:</p>
                    <div style="text-align: center; margin: 30px 0;">
                        <a href="${setupUrl}" style="background-color: #3b82f6; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; font-weight: bold;">Set Up Account</a>
                    </div>
                    <p style="color: #666; font-size: 0.9em;">This link will expire in 48 hours.</p>
                    <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
                    <p style="font-size: 0.8em; color: #999;">If you did not expect this invitation, please ignore this email.</p>
                </div>
            `,
        };

        try {
            await this.transporter.sendMail(mailOptions);
            console.log(`Email sent successfully to ${to}`);
        } catch (error) {
            console.error('Error sending email:', error);
            throw error;
        }
    }

    async sendTrainingAssignedEmail(params: {
        to: string;
        trainingTitle: string;
        trainingUrl?: string | null;
        dueDate?: string | null;
        managerName?: string | null;
        managerEmail?: string | null;
    }) {
        const systemFrom =
            this.configService.get<string>('MAIL_FROM_ADDRESS') ||
            this.configService.get<string>('SMTP_FROM');
        const fromDisplayName = params.managerName ? `${params.managerName} via CV Manager` : 'CV Manager';

        const frontend = this.configService.get<string>('FRONTEND_URL') || 'http://localhost:5173';
        const ctaUrl = params.trainingUrl || frontend + '/employee/training-projects';
        const dueLine = params.dueDate ? `<p style="margin: 6px 0;">Due date: <strong>${params.dueDate}</strong></p>` : '';

        const mailOptions = {
            from: `"${fromDisplayName}" <${systemFrom}>`,
            to: params.to,
            replyTo: params.managerEmail ?? undefined,
            subject: `New training assigned: ${params.trainingTitle}`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 640px; margin: auto; padding: 20px; border: 1px solid #eaeaea; border-radius: 10px;">
                    <h2 style="color: #3b82f6; margin-bottom: 12px;">You have a new training</h2>
                    <p style="margin: 6px 0;">Title: <strong>${params.trainingTitle}</strong></p>
                    ${dueLine}
                    <p style="margin: 6px 0;">Assigned by: ${params.managerName || 'Your manager'}</p>
                    <div style="text-align: center; margin: 22px 0;">
                        <a href="${ctaUrl}" style="background-color: #3b82f6; color: white; padding: 12px 22px; text-decoration: none; border-radius: 6px; font-weight: 600;">Open training</a>
                    </div>
                    <p style="color: #666; font-size: 0.9em;">You can also view all trainings from your dashboard.</p>
                </div>
            `,
        };

        try {
            await this.transporter.sendMail(mailOptions);
        } catch (error) {
            console.error('Error sending training assignment email:', error);
        }
    }

    async sendTeamAddedEmail(to: string, managerName: string, managerEmail?: string) {
        const systemFrom =
            this.configService.get<string>('MAIL_FROM_ADDRESS') ||
            this.configService.get<string>('SMTP_FROM');
        const fromDisplayName = managerName ? `${managerName} via CV Manager` : 'CV Manager';
        const frontend = this.configService.get<string>('FRONTEND_URL') || 'http://localhost:5173';

        const mailOptions = {
            from: `"${fromDisplayName}" <${systemFrom}>`,
            to,
            replyTo: managerEmail ?? undefined,
            subject: `You've been added to ${managerName}'s team`,
            html: `
                <div style="font-family: Arial, sans-serif; max-width: 640px; margin: auto; padding: 20px; border: 1px solid #eaeaea; border-radius: 10px;">
                    <h2 style="color: #3b82f6; margin-bottom: 12px;">Welcome to the Team!</h2>
                    <p style="margin: 6px 0;">You have been added to <strong>${managerName}'s</strong> team on CV Manager.</p>
                    <div style="text-align: center; margin: 22px 0;">
                        <a href="${frontend}/employee/dashboard" style="background-color: #3b82f6; color: white; padding: 12px 22px; text-decoration: none; border-radius: 6px; font-weight: 600;">Go to Dashboard</a>
                    </div>
                </div>
            `,
        };

        try {
            await this.transporter.sendMail(mailOptions);
            console.log(`Team added email sent to ${to}`);
        } catch (error) {
            console.error('Error sending team added email:', error);
        }
    }
}
