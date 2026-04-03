import { FormEvent, useState } from "react";
import { IconLockPassword } from "@tabler/icons-react";

export function LoginScreen(props: { onAuthenticate: (token: string) => void }) {
  const { onAuthenticate } = props;
  const [token, setToken] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedToken = token.trim();
    if (!trimmedToken) {
      return;
    }

    onAuthenticate(trimmedToken);
  }

  return (
    <div className="page page-center dashboard-login-shell">
      <div className="container container-tight py-4">
        <div className="card card-md">
          <div className="card-body">
            <h1 className="text-center mb-2">RedDwarf Control</h1>
            <p className="text-secondary text-center mb-4">
              Paste the operator bearer token for this tab.
            </p>
            <form onSubmit={handleSubmit}>
              <div className="mb-3">
                <label className="form-label" htmlFor="operator-token">
                  Operator Token
                </label>
                <div className="input-icon">
                  <span className="input-icon-addon">
                    <IconLockPassword size={18} />
                  </span>
                  <input
                    autoComplete="current-password"
                    className="form-control"
                    id="operator-token"
                    onChange={(event) => setToken(event.target.value)}
                    placeholder="Enter token"
                    type="password"
                    value={token}
                  />
                </div>
              </div>
              <button className="btn btn-primary w-100" disabled={token.trim().length === 0} type="submit">
                Unlock Dashboard
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
