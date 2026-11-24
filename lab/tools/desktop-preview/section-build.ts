import { replaceEach } from './brand-replace';

export const withSectionIcon = (source: string) =>
  replaceEach(source, [
    [
      'export function Section({\n  title,\n  action,',
      'export function Section({\n  title,\n  icon,\n  action,',
    ],
    [
      '  title: string;\n  action?: ReactNode;',
      '  title: string;\n  icon?: ReactNode;\n  action?: ReactNode;',
    ],
    [
      '<h2>{title}</h2>',
      '<h2>\n          {icon}\n          {title}\n        </h2>',
    ],
  ]);
