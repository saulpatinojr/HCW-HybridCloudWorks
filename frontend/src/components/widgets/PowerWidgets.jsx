import React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { Lightbulb, Award, Info, Code, MessageCircle, CheckCircle } from 'lucide-react';

/**
 * Reusable Power Widgets for adding pizzazz to blog/architecture pages.
 * These can be used in the main content or the sidebar.
 */

// 1. Did You Know? Box
export function DidYouKnow({ title = 'Did You Know?', children, className }) {
  return (
    <Card
      className={cn(
        'border-l-4 border-l-yellow-500 bg-yellow-500/10 dark:bg-yellow-500/5',
        className
      )}
    >
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-bold flex items-center gap-2 text-yellow-600 dark:text-yellow-400">
          <Lightbulb className="h-4 w-4" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground pt-0">{children}</CardContent>
    </Card>
  );
}

// 2. Architect's Recommendation
export function ArchitectRecommendation({ author = 'Chief Architect', children, className }) {
  return (
    <Card className={cn('border-l-4 border-l-primary bg-primary/5', className)}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-bold flex items-center gap-2 text-primary">
          <Award className="h-4 w-4" />
          {author}&apos;s Recommendation
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm italic text-muted-foreground pt-0">
        &quot;{children}&quot;
      </CardContent>
    </Card>
  );
}

// 3. Info/Note Box
export function NoteBox({ type = 'info', title, children, className }) {
  const styles = {
    info: {
      border: 'border-l-blue-500',
      bg: 'bg-blue-500/10',
      icon: Info,
      color: 'text-blue-600 dark:text-blue-400',
    },
    warning: {
      border: 'border-l-orange-500',
      bg: 'bg-orange-500/10',
      icon: MessageCircle,
      color: 'text-orange-600 dark:text-orange-400',
    },
    success: {
      border: 'border-l-green-500',
      bg: 'bg-green-500/10',
      icon: CheckCircle,
      color: 'text-green-600 dark:text-green-400',
    },
  };
  const currentStyle = styles[type] || styles.info;
  const Icon = currentStyle.icon;

  return (
    <Card className={cn(`border-l-4 ${currentStyle.border} ${currentStyle.bg}`, className)}>
      <CardHeader className="pb-2">
        <CardTitle className={`text-sm font-bold flex items-center gap-2 ${currentStyle.color}`}>
          <Icon className="h-4 w-4" />
          {title || type.charAt(0).toUpperCase() + type.slice(1)}
        </CardTitle>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground pt-0">{children}</CardContent>
    </Card>
  );
}

// 4. Code Snippet Highlight (Simple wrapper, ideally use syntax highlighter)
export function CodeHighlight({ language = 'bash', title, children, className }) {
  return (
    <Card className={cn('bg-slate-950 text-slate-50 border-slate-800', className)}>
      <div className="flex items-center justify-between px-4 py-2 bg-slate-900 border-b border-slate-800 text-xs text-slate-400">
        <span className="flex items-center gap-2">
          <Code className="h-3 w-3" /> {title || language}
        </span>
        <span className="opacity-50">Snippet</span>
      </div>
      <CardContent className="p-4 font-mono text-xs overflow-x-auto">
        <pre>{children}</pre>
      </CardContent>
    </Card>
  );
}
