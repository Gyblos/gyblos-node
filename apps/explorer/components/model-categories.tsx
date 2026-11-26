import { Chip } from './board/chip';

export function ModelCategories({
  categories,
}: {
  categories: readonly string[];
}) {
  if (!categories.length) return null;
  return (
    <span className="mt-1 flex flex-wrap gap-1">
      {categories.map((category) => (
        <Chip key={category}>{category}</Chip>
      ))}
    </span>
  );
}
