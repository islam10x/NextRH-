import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class MailService {
    private transporter: nodemailer.Transporter;

    constructor(private configService: ConfigService) {
        const host = this.configService.get<string>('SMTP_HOST');
        const user = this.configService.get<string>('SMTP_USER');

        if (!host || !user) {
            console.warn('WARNING: SMTP configuration is missing. Emails will fail to send.');
        }

        const port = Number(this.configService.get('SMTP_PORT', 2525));
        const secure = this.configService.get('SMTP_SECURE') === 'true'; // Explicit cast from string

        this.transporter = nodemailer.createTransport({
            host,
            port,
            secure,
            auth: {
                user,
                pass: this.configService.get<string>('SMTP_PASS'),
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

        // Use system email for 'From' but set display name to BID Manager
        // This ensures better deliverability (DMARC/SPF) while showing who sent it
        const systemFrom = this.configService.get<string>('SMTP_FROM');
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
}
