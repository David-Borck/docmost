import * as z from "zod";
import { useForm, zodResolver } from "@mantine/form";
import { useState } from "react";
import {
  Container,
  Title,
  TextInput,
  Button,
  PasswordInput,
  Box,
  Text,
  Alert,
} from "@mantine/core";
import classes from "./auth.module.css";
import { useNavigate } from "react-router-dom";
import APP_ROUTE from "@/lib/app-route.ts";
import { useTranslation } from "react-i18next";
import { notifications } from "@mantine/notifications";
import { loginLdap } from "@/features/auth/services/auth-service";
import { IconInfoCircle } from "@tabler/icons-react";

const formSchema = z.object({
  username: z
    .string()
    .min(1, { message: "Username or email is required" }),
  password: z.string().min(1, { message: "Password is required" }),
});

type LdapLoginFormValues = z.infer<typeof formSchema>;

export function LdapLoginForm() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(false);

  const form = useForm<LdapLoginFormValues>({
    validate: zodResolver(formSchema),
    initialValues: {
      username: "",
      password: "",
    },
  });

  async function onSubmit(data: LdapLoginFormValues) {
    setIsLoading(true);

    try {
      await loginLdap(data);
      setIsLoading(false);
      navigate(APP_ROUTE.HOME);
    } catch (err) {
      setIsLoading(false);
      console.error(err);
      notifications.show({
        message: err.response?.data?.message || "LDAP authentication failed",
        color: "red",
      });
    }
  }

  return (
    <Container size={420} className={classes.container}>
      <Box p="xl" className={classes.containerBox}>
        <Title order={2} ta="center" fw={500} mb="md">
          {t("LDAP Login")}
        </Title>

        <Alert
          icon={<IconInfoCircle size={16} />}
          title={t("LDAP Authentication")}
          color="blue"
          mb="md"
        >
          <Text size="sm">
            {t("Use your LDAP credentials to sign in")}
          </Text>
        </Alert>

        <form onSubmit={form.onSubmit(onSubmit)}>
          <TextInput
            id="username"
            label={t("Username or Email")}
            placeholder="username@example.com"
            variant="filled"
            data-autofocus
            {...form.getInputProps("username")}
          />

          <PasswordInput
            label={t("Password")}
            placeholder={t("Your LDAP password")}
            variant="filled"
            mt="md"
            {...form.getInputProps("password")}
          />

          <Button type="submit" fullWidth mt="xl" loading={isLoading}>
            {t("Sign In with LDAP")}
          </Button>
        </form>
      </Box>
    </Container>
  );
}
