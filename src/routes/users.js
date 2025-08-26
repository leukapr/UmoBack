// src/components/components_Dashboard/PersonalInfoForm.jsx
import { useState, useEffect } from "react";
import axios from "axios";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";

export default function PersonalInfoForm({
  token,
  userId,
  profile,
  onProfileUpdated,
}) {
  const API_URL = import.meta.env.VITE_API_URL;
  const { toast } = useToast();

  const [prenom, setPrenom] = useState(profile?.prenom ?? "");
  const [nom, setNom] = useState(profile?.nom ?? "");
  const email = profile?.email ?? "";
  const [saving, setSaving] = useState(false);

  // si le profile se recharge après montage, sync les champs
  useEffect(() => {
    setPrenom(profile?.prenom ?? "");
    setNom(profile?.nom ?? "");
  }, [profile?.prenom, profile?.nom]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = {
        prenom: (prenom || "").trim(),
        nom: (nom || "").trim(),
        // 🔕 pas de téléphone ici
      };
      const { data } = await axios.patch(
        `${API_URL}/api/users/${userId}`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        }
      );
      toast({ title: "Informations enregistrées" });
      onProfileUpdated?.(data);
    } catch (err) {
      const msg = err?.response?.data?.error || "Erreur inconnue";
      toast({
        title: "Échec de l'enregistrement",
        description: msg,
        variant: "destructive",
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="grid gap-4 p-4 sm:p-5 border rounded-md bg-white dark:bg-gray-900"
    >
      <div className="grid gap-1">
        <label className="text-sm font-medium">Prénom</label>
        <input
          type="text"
          value={prenom}
          onChange={(e) => setPrenom(e.target.value)}
          className="h-10 w-full rounded-md border px-3 dark:bg-gray-950"
          placeholder="Votre prénom"
        />
      </div>

      <div className="grid gap-1">
        <label className="text-sm font-medium">Nom</label>
        <input
          type="text"
          value={nom}
          onChange={(e) => setNom(e.target.value)}
          className="h-10 w-full rounded-md border px-3 dark:bg-gray-950"
          placeholder="Votre nom"
        />
      </div>

      <div className="grid gap-1">
        <label className="text-sm font-medium">Email (non modifiable)</label>
        <input
          type="email"
          value={email}
          disabled
          className="h-10 w-full rounded-md border px-3 opacity-70 dark:bg-gray-950"
        />
      </div>

      <div className="pt-1">
        <Button type="submit" disabled={saving}>
          {saving ? "Enregistrement..." : "Enregistrer"}
        </Button>
      </div>
    </form>
  );
}
