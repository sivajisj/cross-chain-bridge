import { render, screen } from "@testing-library/react";
import App from "./App";

test("renders the bridge header and tabs", () => {
  render(<App />);
  expect(screen.getByText(/cross-chain bridge/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /connect metamask/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^bridge$/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^explorer$/i })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^metrics$/i })).toBeInTheDocument();
});
