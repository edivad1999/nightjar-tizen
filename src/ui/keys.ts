export type NavAction = "up" | "down" | "left" | "right" | "activate" | "back" | "exit";

export function keyAction(code: string, keyCode: number): NavAction | null {
  if (code === "ArrowUp" || keyCode === 38) {
    return "up";
  }
  if (code === "ArrowDown" || keyCode === 40) {
    return "down";
  }
  if (code === "ArrowLeft" || keyCode === 37) {
    return "left";
  }
  if (code === "ArrowRight" || keyCode === 39) {
    return "right";
  }
  if (code === "Enter" || code === "NumpadEnter" || keyCode === 13) {
    return "activate";
  }
  if (code === "Escape" || code === "Backspace" || keyCode === 10009 || keyCode === 461) {
    return "back";
  }
  if (keyCode === 10182 || code === "Exit") {
    return "exit";
  }
  return null;
}
