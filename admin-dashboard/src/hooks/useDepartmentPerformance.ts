import { useQueries, useQuery } from '@tanstack/react-query';
import api from '@/services/api';

interface Department {
  id: string;
  name: string;
}

interface DepartmentAnalytics {
  emailsReceived: number;
  emailsReplied: number;
  pendingEmails: number;
  avgReplyTimeSec: number | null;
  performanceScore: number | null;
  aiUsageRatio: number | null;
}

/**
 * Fetches the department list, then fans out one request per department to
 * /api/analytics/departments/:id (trailing 7 days, the route's default
 * range) and returns a flat array shaped for a recharts <BarChart>. Fine at
 * the department counts a single company realistically has; if that ever
 * grows large, this is the spot to add a bulk backend endpoint instead.
 */
export function useDepartmentPerformance() {
  const departmentsQuery = useQuery({
    queryKey: ['departments'],
    queryFn: async () => {
      const { data } = await api.get<Department[]>('/departments');
      return data;
    },
  });

  const departments = departmentsQuery.data ?? [];

  const analyticsQueries = useQueries({
    queries: departments.map((dept) => ({
      queryKey: ['department-analytics', dept.id],
      queryFn: async () => {
        const { data } = await api.get<{ department: Department } & DepartmentAnalytics>(
          `/analytics/departments/${dept.id}`
        );
        return data;
      },
      enabled: Boolean(dept.id),
    })),
  });

  const isLoading = departmentsQuery.isLoading || analyticsQueries.some((q) => q.isLoading);

  const chartData = analyticsQueries
    .filter((q) => q.data)
    .map((q) => ({
      name: q.data!.department.name,
      score: Math.round(q.data!.performanceScore ?? 0),
    }));

  return { chartData, isLoading };
}
