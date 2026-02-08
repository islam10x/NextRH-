import React, { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { mockEmployees } from '@/data/mockData';
import { CVFormat, FontOption } from '@/types';
import { FileOutput, Download, Eye, Loader2, Check } from 'lucide-react';
import { cn } from '@/lib/utils';

const formats: { value: CVFormat; label: string; desc: string }[] = [
  { value: 'standard', label: 'Standard', desc: 'Default professional format' },
  { value: 'canadian', label: 'Canadian', desc: 'Canadian government format' },
  { value: 'eu', label: 'EU Europass', desc: 'European standard format' },
  { value: 'client_specific', label: 'Client Specific', desc: 'Custom client template' },
];

const fonts: FontOption[] = ['Arial', 'Times New Roman', 'Calibri', 'Helvetica'];

const CVGenerationPage: React.FC = () => {
  const [selectedEmployee, setSelectedEmployee] = useState('');
  const [selectedFormat, setSelectedFormat] = useState<CVFormat>('standard');
  const [selectedFont, setSelectedFont] = useState<FontOption>('Arial');
  const [isGenerating, setIsGenerating] = useState(false);
  const [isGenerated, setIsGenerated] = useState(false);

  const handleGenerate = async () => {
    if (!selectedEmployee) return;
    setIsGenerating(true);
    setIsGenerated(false);
    await new Promise(r => setTimeout(r, 2000));
    setIsGenerating(false);
    setIsGenerated(true);
  };

  return (
    <div className="space-y-6 max-w-3xl mx-auto">
      <div>
        <h1 className="text-2xl font-bold">Generate CV</h1>
        <p className="text-muted-foreground">Create formatted CVs for bids and proposals</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>CV Configuration</CardTitle>
          <CardDescription>Select employee and format options</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label>Select Employee</Label>
            <Select value={selectedEmployee} onValueChange={setSelectedEmployee}>
              <SelectTrigger><SelectValue placeholder="Choose an employee" /></SelectTrigger>
              <SelectContent>
                {mockEmployees.map((emp) => (
                  <SelectItem key={emp.id} value={emp.id}>{emp.name} - {emp.title}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label>CV Format</Label>
            <div className="grid grid-cols-2 gap-3">
              {formats.map((fmt) => (
                <div
                  key={fmt.value}
                  className={cn("p-4 rounded-lg border-2 cursor-pointer transition-all", selectedFormat === fmt.value ? "border-primary bg-primary/5" : "border-muted hover:border-primary/50")}
                  onClick={() => setSelectedFormat(fmt.value)}
                >
                  <p className="font-medium">{fmt.label}</p>
                  <p className="text-xs text-muted-foreground">{fmt.desc}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Font</Label>
            <Select value={selectedFont} onValueChange={(v) => setSelectedFont(v as FontOption)}>
              <SelectTrigger className="w-[200px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                {fonts.map((f) => <SelectItem key={f} value={f}>{f}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <Button onClick={handleGenerate} disabled={!selectedEmployee || isGenerating} className="w-full">
            {isGenerating ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Generating...</> : <><FileOutput className="h-4 w-4 mr-2" />Generate CV</>}
          </Button>

          {isGenerated && (
            <div className="p-4 rounded-lg bg-success/10 border border-success/20">
              <div className="flex items-center gap-3 mb-3">
                <Check className="h-5 w-5 text-success" />
                <p className="font-medium text-success">CV Generated Successfully</p>
              </div>
              <div className="flex gap-2">
                <Button variant="outline" size="sm"><Eye className="h-4 w-4 mr-1" />Preview</Button>
                <Button size="sm"><Download className="h-4 w-4 mr-1" />Download PDF</Button>
                <Button variant="outline" size="sm"><Download className="h-4 w-4 mr-1" />Download DOCX</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

export default CVGenerationPage;
