import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Certification } from "../certifications/entities/certification.entity";
import { CertificationAlert } from "./entities/certification-alert.entity";
import { NotificationsService } from "./notifications.service";

@Injectable()
export class CertificationAlertService {
  private readonly logger = new Logger(CertificationAlertService.name);

  constructor(
    @InjectRepository(Certification)
    private readonly certRepo: Repository<Certification>,

    @InjectRepository(CertificationAlert)
    private readonly alertRepo: Repository<CertificationAlert>,

    private readonly notificationsService: NotificationsService,
  ) {}

  /**
   * Runs every day at 7:00 AM.
   * Checks for certifications expiring within 30 days and creates
   * alerts + in-app notifications for the owning users.
   */
  @Cron(CronExpression.EVERY_DAY_AT_7AM, { name: "certification-expiry-check" })
  async handleCertificationExpiryCheck() {
    this.logger.log("Running daily certification expiry check…");

    try {
      const now = new Date();
      const in30Days = new Date();
      in30Days.setDate(now.getDate() + 30);

      // Find certifications expiring within the next 30 days
      // that have NOT already been alerted for the 30-day window
      const expiringCerts = await this.certRepo
        .createQueryBuilder("c")
        .leftJoinAndSelect("c.profile", "p")
        .leftJoinAndSelect("p.user", "u")
        .where("c.expiration_date IS NOT NULL")
        .andWhere("c.expiration_date > :now", {
          now: now.toISOString().slice(0, 10),
        })
        .andWhere("c.expiration_date <= :in30", {
          in30: in30Days.toISOString().slice(0, 10),
        })
        .getMany();

      let created = 0;

      for (const cert of expiringCerts) {
        // Check if a 30-day alert already exists for this certification
        const existingAlert = await this.alertRepo.findOne({
          where: {
            certification: { certification_id: cert.certification_id },
            alertType: "expiring_30_days",
          },
        });

        if (existingAlert) continue; // already alerted

        const daysLeft = Math.ceil(
          (new Date(cert.expirationDate).getTime() - now.getTime()) /
            (1000 * 60 * 60 * 24),
        );

        // Create the alert record
        const alert = this.alertRepo.create({
          certification: cert,
          alertType: "expiring_30_days",
          daysUntilExpiration: daysLeft,
          notificationSent: true,
        });
        await this.alertRepo.save(alert);

        // Create an in-app notification for the cert owner
        const userId = cert.profile?.user?.user_id;
        if (userId) {
          await this.notificationsService.create({
            userId,
            type: "certification_expiring",
            title: `Certification expiring soon`,
            message: `Your certification "${cert.certificationName}" expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"} (${new Date(cert.expirationDate).toLocaleDateString()}).`,
            relatedEntityType: "certification",
            relatedEntityId: cert.certification_id,
            priority: daysLeft <= 7 ? 3 : 2,
          });
          created++;
        }
      }

      // Also check for already-expired certifications that haven't been alerted
      const expiredCerts = await this.certRepo
        .createQueryBuilder("c")
        .leftJoinAndSelect("c.profile", "p")
        .leftJoinAndSelect("p.user", "u")
        .where("c.expiration_date IS NOT NULL")
        .andWhere("c.expiration_date <= :now", {
          now: now.toISOString().slice(0, 10),
        })
        .andWhere("c.expiration_date > :recentCutoff", {
          recentCutoff: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
            .toISOString()
            .slice(0, 10),
        })
        .getMany();

      for (const cert of expiredCerts) {
        const existingAlert = await this.alertRepo.findOne({
          where: {
            certification: { certification_id: cert.certification_id },
            alertType: "expired",
          },
        });

        if (existingAlert) continue;

        const alert = this.alertRepo.create({
          certification: cert,
          alertType: "expired",
          daysUntilExpiration: 0,
          notificationSent: true,
        });
        await this.alertRepo.save(alert);

        const userId = cert.profile?.user?.user_id;
        if (userId) {
          await this.notificationsService.create({
            userId,
            type: "certification_expired",
            title: `Certification expired`,
            message: `Your certification "${cert.certificationName}" has expired on ${new Date(cert.expirationDate).toLocaleDateString()}.`,
            relatedEntityType: "certification",
            relatedEntityId: cert.certification_id,
            priority: 3,
          });
          created++;
        }
      }

      this.logger.log(
        `Certification expiry check complete. ${created} new notification(s) created.`,
      );
    } catch (error) {
      this.logger.error("Certification expiry check failed", error.stack);
    }
  }
}
