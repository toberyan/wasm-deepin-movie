import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./Icon";

export interface MenuEntry {
  label: string;
  icon?: IconName;
  meta?: string;
  disabled?: boolean;
  selected?: boolean;
  separator?: boolean;
  children?: MenuEntry[];
  onSelect?: () => void;
}

interface MenuProps {
  items: MenuEntry[];
  anchor: RefObject<HTMLElement | null>;
  point?: { x: number; y: number };
  onClose: () => void;
  className?: string;
}

function MenuLevel({ items, anchor, point, onClose, className = "", nested = false, onBack }: MenuProps & {
  nested?: boolean;
  onBack?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const buttons = useRef(new Map<number, HTMLButtonElement>());
  const [child, setChild] = useState<number | null>(null);
  const childAnchor = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const position = () => {
      const rect = anchor.current?.getBoundingClientRect();
      const width = menu.offsetWidth;
      const height = menu.offsetHeight;
      let x = point?.x ?? (nested ? rect?.right ?? 0 : (rect?.right ?? width) - width);
      let y = point?.y ?? (nested ? rect?.top ?? 0 : (rect?.bottom ?? 0) + 6);
      if (nested && x + width > window.innerWidth - 8) x = (rect?.left ?? x) - width;
      if (!nested && !point && y + height > window.innerHeight - 8) y = (rect?.top ?? y) - height - 6;
      menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - width - 8))}px`;
      menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - height - 8))}px`;
    };
    position();
    menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    window.addEventListener("resize", position);
    return () => window.removeEventListener("resize", position);
  }, [anchor, point, nested]);

  const dismiss = () => onClose();
  const back = () => { onBack?.(); anchor.current?.focus(); };
  const entry = child === null ? undefined : items[child];

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={nested ? anchor.current?.textContent ?? "子菜单" : "播放器菜单"}
      className={`player-menu menu-panel ${className}`}
      onKeyDown={(event) => {
        event.stopPropagation();
        const enabled = [...buttons.current.values()].filter((button) => !button.disabled);
        const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
        const current = [...buttons.current].find(([, button]) => button === document.activeElement);
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const next = event.key === "Home" ? 0 : event.key === "End" ? enabled.length - 1 :
            (index + (event.key === "ArrowDown" ? 1 : -1) + enabled.length) % enabled.length;
          enabled[next]?.focus();
          setChild(null);
        } else if (event.key === "ArrowRight" && current && items[current[0]]?.children) {
          event.preventDefault(); childAnchor.current = current[1]; setChild(current[0]);
        } else if (event.key === "ArrowLeft" && nested) {
          event.preventDefault(); back();
        } else if (event.key === "Escape") {
          event.preventDefault(); if (nested) back(); else dismiss();
        } else if (event.key === "Tab") {
          event.preventDefault(); dismiss();
        }
      }}
    >
      {items.map((item, index) => (
        <div key={`${index}-${item.label}`}>
          {item.separator && <div className="menu-separator" role="separator" />}
          <button
            ref={(button) => { if (button) buttons.current.set(index, button); else buttons.current.delete(index); }}
            className={`menu-item ${item.selected ? "selected" : ""}`}
            role={item.selected !== undefined ? "menuitemradio" : "menuitem"}
            aria-checked={item.selected}
            aria-haspopup={item.children ? "menu" : undefined}
            aria-expanded={item.children ? child === index : undefined}
            disabled={item.disabled}
            onPointerEnter={(event) => {
              if (item.disabled) return;
              if (item.children) { childAnchor.current = event.currentTarget; setChild(index); }
              else setChild(null);
            }}
            onClick={(event) => {
              if (item.children) { childAnchor.current = event.currentTarget; setChild(index); }
              else { dismiss(); item.onSelect?.(); }
            }}
          >
            <span className="menu-item-icon">{item.selected ? <Icon name="check" size={15} /> : item.icon ? <Icon name={item.icon} size={16} /> : null}</span>
            <span className="menu-item-label">{item.label}</span>
            {item.meta && <span className="menu-meta">{item.meta}</span>}
            {item.children && <Icon name="chevronRight" size={13} />}
          </button>
        </div>
      ))}
      {entry?.children && <MenuLevel key={child} items={entry.children} anchor={childAnchor} nested onBack={() => setChild(null)} onClose={onClose} />}
    </div>
  );
}

export function PlayerMenu(props: MenuProps) {
  const { anchor, onClose } = props;
  useLayoutEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Element &&
        !event.target.closest(".player-menu") && !anchor.current?.contains(event.target)) onClose();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [anchor, onClose]);
  return createPortal(<MenuLevel {...props} onClose={() => { onClose(); anchor.current?.focus(); }} />, document.body);
}
