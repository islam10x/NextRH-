import React from 'react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { CertificationStatus } from '@/types';

interface StatusBadgeProps {
  status: CertificationStatus;
  className?: string;
  showDot?: boolean;
}

const statusConfig: Record<CertificationStatus, { label: string; className: string; dotColor: string }> = {
  active: {
    label: 'Active',
    className: 'bg-success/10 text-success hover:bg-success/20 border-success/20',
    dotColor: 'bg-success',
  },
  expiring_soon: {
    label: 'Expiring Soon',
    className: 'bg-warning/10 text-warning hover:bg-warning/20 border-warning/20',
    dotColor: 'bg-warning',
  },
  expired: {
    label: 'Expired',
    className: 'bg-destructive/10 text-destructive hover:bg-destructive/20 border-destructive/20',
    dotColor: 'bg-destructive',
  },
};

export const StatusBadge: React.FC<StatusBadgeProps> = ({ status, className, showDot = true }) => {
  const config = statusConfig[status];

  return (
    <Badge variant="outline" className={cn('font-medium', config.className, className)}>
      {showDot && <span className={cn('w-1.5 h-1.5 rounded-full mr-1.5', config.dotColor)} />}
      {config.label}
    </Badge>
  );
};

export default StatusBadge;
