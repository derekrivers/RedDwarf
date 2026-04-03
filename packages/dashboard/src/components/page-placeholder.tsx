import { IconStars } from "@tabler/icons-react";

export function PagePlaceholder(props: {
  title: string;
  description: string;
}) {
  const { title, description } = props;

  return (
    <div className="empty">
      <div className="empty-img">
        <IconStars size={72} stroke={1.5} />
      </div>
      <p className="empty-title">{title}</p>
      <p className="empty-subtitle text-secondary">{description}</p>
    </div>
  );
}
