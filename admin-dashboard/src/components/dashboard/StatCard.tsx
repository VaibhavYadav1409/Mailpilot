import { motion } from 'framer-motion';
import { LucideIcon } from 'lucide-react';
import { cn } from '@/utils/cn';

interface StatCardProps {
  title: string;
  value: string | number;
  icon: LucideIcon;
  trend?: {
    value: number;
    isUp: boolean;
  };
  live?: boolean;
}

export const StatCard = ({ title, value, icon: Icon, trend, live }: StatCardProps) => {
  return (
    <motion.div
      whileHover={{ y: -3 }}
      transition={{ type: 'spring', stiffness: 300, damping: 24 }}
      className="glass-card panel-ticks p-5"
    >
      <div className="flex items-center justify-between mb-5">
        <div className="p-2 bg-primary/10 rounded-lg">
          <Icon className="w-[18px] h-[18px] text-primary" strokeWidth={2} />
        </div>
        {trend ? (
          <span
            className={cn(
              'text-xs font-mono font-medium px-1.5 py-0.5 rounded',
              trend.isUp ? 'text-emerald-600 bg-emerald-500/10' : 'text-red-500 bg-red-500/10'
            )}
          >
            {trend.isUp ? '+' : '-'}
            {trend.value}%
          </span>
        ) : live ? (
          <span className="flex items-center gap-1.5 text-[10px] font-mono tracking-wider uppercase text-emerald-600">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 beacon-dot" />
            Live
          </span>
        ) : null}
      </div>
      <h3 className="text-[13px] font-medium text-gray-500">{title}</h3>
      <p className="font-tabular text-[26px] font-semibold mt-1">{value}</p>
    </motion.div>
  );
};
