import React, { useEffect, useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Loader2, Trophy } from 'lucide-react';
import { scoringService, LeaderboardEntry } from '@/services/scoring.service';
import { EmptyState } from '@/components/common/EmptyState';

const CURRENT_YEAR = new Date().getFullYear();
const YEARS = [CURRENT_YEAR, CURRENT_YEAR - 1, CURRENT_YEAR - 2];

const BIDScoringPage: React.FC = () => {
  const [year, setYear] = useState(CURRENT_YEAR);
  const [leaderboard, setLeaderboard] = useState<LeaderboardEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    scoringService.getLeaderboard(year)
      .then(setLeaderboard)
      .catch(() => setLeaderboard([]))
      .finally(() => setLoading(false));
  }, [year]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Trophy className="h-6 w-6 text-yellow-500" />
            Company Leaderboard
          </h1>
          <p className="text-muted-foreground text-sm">Overall employee performance ranking</p>
        </div>
        <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {YEARS.map((y) => (
              <SelectItem key={y} value={String(y)}>{y}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Rankings {year}</CardTitle>
          <CardDescription>Sorted by final score — combines projects, certifications, trainings, and formations.</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <Loader2 className="h-8 w-8 animate-spin text-primary/40" />
            </div>
          ) : leaderboard.length === 0 ? (
            <EmptyState
              icon={<Trophy />}
              title="No scores for this year"
              description="Scores are computed once employees upload their CV and are evaluated by their manager."
            />
          ) : (
            <div className="rounded-lg border border-slate-200 overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
                    <TableHead className="w-16">Rank</TableHead>
                    <TableHead>Employee</TableHead>
                    <TableHead className="text-right">Projects</TableHead>
                    <TableHead className="text-right">Cert.</TableHead>
                    <TableHead className="text-right">Training</TableHead>
                    <TableHead className="text-right">Formation</TableHead>
                    <TableHead className="text-right font-semibold">Final</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {leaderboard.map((entry) => (
                    <TableRow key={entry.profileId} className="hover:bg-slate-50">
                      <TableCell>
                        <Badge variant={entry.rank <= 3 ? 'default' : 'secondary'} className={
                          entry.rank === 1 ? 'bg-yellow-100 text-yellow-800 hover:bg-yellow-100' :
                          entry.rank === 2 ? 'bg-slate-100 text-slate-700 hover:bg-slate-100' :
                          entry.rank === 3 ? 'bg-orange-100 text-orange-700 hover:bg-orange-100' : ''
                        }>
                          #{entry.rank}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-medium">{entry.employeeName}</TableCell>
                      <TableCell className="text-right text-muted-foreground">{Number(entry.projectScore).toFixed(1)}</TableCell>
                      <TableCell className="text-right text-muted-foreground">{Number(entry.certificationScore).toFixed(1)}</TableCell>
                      <TableCell className="text-right text-muted-foreground">{Number(entry.trainingScore).toFixed(1)}</TableCell>
                      <TableCell className="text-right text-muted-foreground">{Number(entry.formationScore).toFixed(1)}</TableCell>
                      <TableCell className="text-right font-bold">{Number(entry.finalScore).toFixed(1)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default BIDScoringPage;
