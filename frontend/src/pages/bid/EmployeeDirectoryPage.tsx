import React, { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { mockEmployees, searchEmployees } from '@/data/mockData';
import { Search, Eye, Award, Filter } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

const EmployeeDirectoryPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const employees = searchQuery ? searchEmployees(searchQuery) : mockEmployees;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Employee Directory</h1>
        <p className="text-muted-foreground">Search and filter employees for bids</p>
      </div>
      <Card>
        <CardContent className="py-4">
          <div className="relative max-w-lg">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input placeholder="Search by name, skill, or certification..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pl-10" />
          </div>
        </CardContent>
      </Card>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {employees.map((emp) => (
          <Card key={emp.id} className="hover:shadow-md transition-shadow animate-fade-in">
            <CardContent className="p-5">
              <div className="flex items-start gap-4">
                <Avatar className="h-12 w-12">
                  <AvatarFallback className="bg-primary/10 text-primary">{emp.name.split(' ').map(n => n[0]).join('')}</AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <h3 className="font-semibold truncate">{emp.name}</h3>
                  <p className="text-sm text-muted-foreground">{emp.title}</p>
                  <p className="text-xs text-muted-foreground">{emp.yearsOfExperience} years exp.</p>
                </div>
              </div>
              <div className="flex items-center gap-2 mt-3 text-sm">
                <Award className="h-4 w-4 text-success" />
                <span>{emp.certifications.filter(c => c.status === 'active').length} active certs</span>
              </div>
              <div className="flex flex-wrap gap-1 mt-3">
                {emp.skills.slice(0, 3).map((skill) => (<Badge key={skill} variant="secondary" className="text-xs">{skill}</Badge>))}
              </div>
              <Button variant="outline" size="sm" className="w-full mt-4" onClick={() => navigate(`/bid/employee/${emp.id}`)}>
                <Eye className="h-4 w-4 mr-1" />View Profile
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
};

export default EmployeeDirectoryPage;
