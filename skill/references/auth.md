# takealot authentication

## Where the CLI keeps credentials

The CLI keeps credentials, tokens and the device record in `~/.config/takealot-cli/credentials.json`. The file mode is `0600`. The CLI refreshes tokens automatically. Use a different `XDG_CONFIG_HOME` for each account on one machine.

## Unattended use

Give the credentials through the environment:

```bash
TAKEALOT_EMAIL="$(op-sa read op://Agents/takealot/username)" \
TAKEALOT_PASSWORD="$(op-sa read op://Agents/takealot/password)" \
  takealot cart --json
```

Do not run `takealot login --reset` without a person at the terminal. It asks for the email and password.

## First login or an untrusted device

A device that Takealot does not trust must complete one OTP step.

1. Start the challenge:

   ```bash
   takealot login --json
   ```

   The output is `{"status":"otp_required","challenge":"<nonce>","otpSentTo":"...","expiresInSec":300}`.

2. Ask the owner for the code. Do not guess it and do not read it from another source without his permission.

3. Send the code with the challenge:

   ```bash
   TAKEALOT_OTP=<code> TAKEALOT_CHALLENGE=<nonce> takealot login --json
   ```

Use the environment variables, not `--otp` and `--challenge`. Flags can stay in the process list and in shell history.

Auth error codes are `otp_required`, `otp_state_mismatch` and `otp_expired` (exit 3). After `otp_expired`, start again at step 1.

## Device trust

During the OTP step, the CLI sends the `__cf_bm` cookie from the first response with the second request.


After one OTP login with device trust, later logins normally skip the OTP. This includes a full login after the tokens expire. This is true only while Takealot still trusts the stored device.

New credentials use the device profile of Android app 4.3.0, build 800751. Existing credentials keep their stored profile, because a new profile can end the trust. To use the new default, delete only `device.profile` from the credentials file. The next login can then need an OTP again.
