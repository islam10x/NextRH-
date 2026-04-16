import React from 'react';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { FileOutput, Loader2, Globe, Cpu, Settings2 } from 'lucide-react';
import { cn } from '@/lib/utils';

export type TemplateType = 'standard' | 'canadian' | 'eu' | 'client_specific';
export type EngineMode = 'primary' | 'fallback';

export interface CvTemplate {
  id: string;
  templateName: string;
  templateType: TemplateType;
  language?: string | null;
}

interface CVTemplateSelectorProps {
  templates: CvTemplate[];
  selectedTemplate: string;
  onTemplateChange: (val: string) => void;
  selectedType: TemplateType;
  onTypeChange: (val: TemplateType) => void;
  language: string;
  onLanguageChange: (val: string) => void;
  translateEnabled: boolean;
  onTranslateChange: (val: boolean) => void;
  engine: EngineMode;
  onEngineChange: (val: EngineMode) => void;
  onGenerate: () => void;
  isGenerating: boolean;
  className?: string;
}

const templateTypeOptions: { value: TemplateType; label: string }[] = [
  { value: 'standard', label: 'Standard' },
  { value: 'canadian', label: 'Canadian' },
  { value: 'eu', label: 'Europass' },
  { value: 'client_specific', label: 'Client Specific' },
];

export const CVTemplateSelector: React.FC<CVTemplateSelectorProps> = ({
  templates,
  selectedTemplate,
  onTemplateChange,
  selectedType,
  onTypeChange,
  language,
  onLanguageChange,
  translateEnabled,
  onTranslateChange,
  engine,
  onEngineChange,
  onGenerate,
  isGenerating,
  className,
}) => {
  const filteredTemplates = templates.filter((t) => t.templateType === selectedType);

  return (
    <div className={cn("space-y-6", className)}>
      <div className="space-y-4">
        {/* Template Type Selection */}
        <div className="space-y-2">
          <Label className="text-sm font-bold uppercase text-muted-foreground tracking-wider">Format Style</Label>
          <div className="grid grid-cols-2 gap-2">
            {templateTypeOptions.map((opt) => (
              <button
                key={opt.value}
                onClick={() => onTypeChange(opt.value)}
                className={cn(
                  "px-4 py-3 text-sm font-medium rounded-lg border text-left transition-all",
                  selectedType === opt.value 
                    ? "border-primary bg-primary/5 text-primary ring-1 ring-primary"
                    : "border-muted bg-background hover:border-primary/40 hover:bg-muted/50"
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Template Selection */}
        <div className="space-y-2">
          <Label className="text-sm font-bold uppercase text-muted-foreground tracking-wider">Specific Design</Label>
          <Select value={selectedTemplate} onValueChange={onTemplateChange}>
            <SelectTrigger className="h-12 border-muted-foreground/20 text-sm">
              <SelectValue placeholder="Choose a design..." />
            </SelectTrigger>
            <SelectContent>
              {filteredTemplates.length > 0 ? (
                filteredTemplates.map((t) => (
                  <SelectItem key={t.id} value={t.id} className="text-sm">
                    {t.templateName}
                  </SelectItem>
                ))
              ) : (
                <div className="px-2 py-4 text-center text-sm text-muted-foreground">
                  No templates in this category
                </div>
              )}
            </SelectContent>
          </Select>
        </div>

        {/* AI Engine Selection */}
        <div className="pt-4 border-t space-y-3">
          <Label className="text-sm font-bold uppercase text-muted-foreground tracking-wider flex items-center gap-1.5">
            <Cpu className="h-4 w-4" />
            Generation Engine
          </Label>
          <Select value={engine} onValueChange={(v) => onEngineChange(v as EngineMode)}>
            <SelectTrigger className="h-11 text-sm bg-muted/30">
              <SelectValue placeholder="Select Engine" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="primary" className="text-sm">Primary (Standard Engine)</SelectItem>
              <SelectItem value="fallback" className="text-sm">Fallback (AI Engine)</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground leading-relaxed italic">
            Use Fallback if the primary output lacks complex formatting resolution.
          </p>
        </div>

        {/* Translation Section */}
        <div className="pt-4 border-t space-y-4">
           <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label className="text-base font-semibold flex items-center gap-2 underline-offset-4 decoration-primary/30">
                  <Globe className="h-4 w-4" />
                  AI Translation
                </Label>
                <p className="text-xs text-muted-foreground">Localize summary and experience</p>
              </div>
              <Switch checked={translateEnabled} onCheckedChange={onTranslateChange} />
           </div>

           {translateEnabled && (
             <div className="animate-in fade-in slide-in-from-top-1 duration-200">
                <Select value={language || 'original'} onValueChange={(v) => onLanguageChange(v === 'original' ? '' : v)}>
                  <SelectTrigger className="h-11 text-sm bg-muted/30">
                    <SelectValue placeholder="Keep Original Language" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="original" className="text-sm">Keep Original Language</SelectItem>
                    <SelectItem value="en" className="text-sm">English</SelectItem>
                    <SelectItem value="fr" className="text-sm">French</SelectItem>
                    <SelectItem value="es" className="text-sm">Spanish</SelectItem>
                    <SelectItem value="de" className="text-sm">German</SelectItem>
                  </SelectContent>
                </Select>
             </div>
           )}
        </div>
      </div>

      <Button 
        onClick={onGenerate} 
        disabled={isGenerating || !selectedTemplate} 
        className="w-full h-11 shadow-lg shadow-primary/20"
      >
        {isGenerating ? (
          <>
            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            Generating Document...
          </>
        ) : (
          <>
            <FileOutput className="h-4 w-4 mr-2" />
            Generate Professional CV
          </>
        )}
      </Button>
    </div>
  );
};
